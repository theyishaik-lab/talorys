package com.talorys.keyboard.suggest

import kotlin.math.exp
import kotlin.math.ln

/**
 * The spatial ("key probability") model shared by the touch layer and the decoder.
 *
 * A tap is modelled as a 2-D Gaussian around the centre of the key the user meant, so
 * `ln P(touch | key) = -d² / (2σ²)` with `d` in key widths. Two uses:
 *
 * 1. **Dynamic hit boxes** ([pickKey]): a touch near the border between two keys goes to the
 *    key that is likelier given both the touch position and what the language model expects
 *    next (Gboard does the same). A touch well inside a key always stays on it.
 * 2. **Decoder substitution costs** ([substitutionCost]): when the word engine considers that the
 *    user meant key `w` instead of the typed key `t`, the cost depends on where the finger
 *    actually landed: a tap on the border of `t` and `w` makes `w` cheap, a tap dead centre on `t`
 *    makes it a normal neighbour slip, a tap far from `w` a full edit.
 */
object SpatialModel {

    /** Gaussian spread of taps around the intended key, in key widths. */
    const val SIGMA = 0.42f

    /** Weight of the language model in [pickKey]. */
    const val LM_WEIGHT = 0.55f

    /** Touches deeper than this (fraction of the half key, 0 = centre, 1 = border) never move. */
    const val SAFE_CORE = 0.55f

    /** ln P(touch | key) for a touch at [dx], [dy] key widths from the key centre (unnormalised). */
    fun logLikelihood(dx: Float, dy: Float): Float = -(dx * dx + dy * dy) / (2f * SIGMA * SIGMA)

    /**
     * Picks the key for a touch.
     * @param geometric the key whose box contains the touch.
     * @param touch the touch in key units (x / keyWidth, y / keyWidth).
     * @param core how deep in [geometric] the touch is: 0 at its centre, 1 at its border.
     * @param candidates the letter keys around (centre in key units), including [geometric].
     * @param nextChar P(next char) from the language model, or null when unknown.
     */
    fun pickKey(
        geometric: Char, touch: Pt, core: Float,
        candidates: Map<Char, Pt>, nextChar: Map<Char, Float>?,
    ): Char {
        if (nextChar.isNullOrEmpty() || core < SAFE_CORE) return geometric
        var best = geometric
        var bestScore = Float.NEGATIVE_INFINITY
        for ((c, p) in candidates) {
            val dx = touch.x - p.x; val dy = touch.y - p.y
            // Only adjacent keys compete: never jump over a key.
            if (c != geometric && dx * dx + dy * dy > 1.0f) continue
            val prior = nextChar[c] ?: 0f
            val s = logLikelihood(dx, dy) + LM_WEIGHT * ln(prior + PRIOR_FLOOR)
            if (s > bestScore) { bestScore = s; best = c }
        }
        return best
    }

    /**
     * Cost (in edits) of reading a tap on [typed] as the key [meant], given where the finger landed.
     * [touch], [typedPos] and [meantPos] are in key units.
     */
    fun substitutionCost(touch: Pt, typedPos: Pt, meantPos: Pt): Float {
        val dt = sq(touch.x - typedPos.x) + sq(touch.y - typedPos.y)
        val dm = sq(touch.x - meantPos.x) + sq(touch.y - meantPos.y)
        return (0.08f + 0.37f * (dm - dt)).coerceIn(0.08f, 1f)
    }

    /** Probability-weighted share of each next letter from (word, weight) completions. */
    fun nextCharDistribution(prefix: String, completions: Sequence<Pair<String, Float>>): Map<Char, Float> {
        val acc = HashMap<Char, Float>()
        var total = 0f
        for ((w, logP) in completions) {
            if (w.length <= prefix.length || !w.startsWith(prefix)) continue
            val p = exp(logP)
            acc.merge(w[prefix.length], p, Float::plus)
            total += p
        }
        if (total <= 0f) return emptyMap()
        for (k in acc.keys.toList()) acc[k] = acc[k]!! / total
        return acc
    }

    private const val PRIOR_FLOOR = 0.002f
    private fun sq(v: Float) = v * v
}
