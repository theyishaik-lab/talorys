package com.talorys.keyboard.suggest

import kotlin.math.hypot
import kotlin.math.min

/**
 * Typo costs for one keyboard: substituting a neighbouring key is cheap, a far one is a full edit.
 * [keys] are key centres; [keyWidth] scales them to key units.
 */
class KeyProximity(keys: Map<Char, Pt>, private val keyWidth: Float) {

    private val pos: Map<Char, Pt> = keys.mapValues { Pt(it.value.x / keyWidth, it.value.y / keyWidth) }

    /** Key centres in key units (for the spatial model). */
    val keyUnits: Map<Char, Pt> get() = pos

    /** A point in the same pixel space as the constructor's key centres, in key units. */
    fun toKeyUnits(p: Pt): Pt = Pt(p.x / keyWidth, p.y / keyWidth)

    /** Keys within about one key of [c] (excluding itself). */
    val neighbours: Map<Char, CharArray> = pos.mapValues { (c, p) ->
        pos.filter { (d, q) -> d != c && hypot(p.x - q.x, p.y - q.y) <= ADJACENT }.keys.toCharArray()
    }

    /**
     * Substitution cost of the typed key [a] read as [b]. With the [touch] (key units) where the
     * finger landed, the spatial model decides how plausible [b] was.
     */
    fun substitution(a: Char, b: Char, touch: Pt?): Float {
        val base = substitution(a, b)
        if (touch == null || a == b) return base
        val p = pos[a] ?: return base
        val q = pos[b] ?: return base
        if (base >= 1f && hypot(p.x - q.x, p.y - q.y) > 2.1f) return base
        return min(base, SpatialModel.substitutionCost(touch, p, q))
    }

    fun substitution(a: Char, b: Char): Float {
        if (a == b) return 0f
        if (pairOf(a, b) in CHEAP_PAIRS) return 0.2f
        if (pairOf(a, b) in SOUND_ALIKE) return 0.6f
        val p = pos[a] ?: return 1f
        val q = pos[b] ?: return 1f
        val d = hypot(p.x - q.x, p.y - q.y)
        return when {
            d <= ADJACENT -> 0.45f
            d <= 2.1f -> 0.85f
            else -> 1f
        }
    }

    /**
     * Weighted Damerau-Levenshtein distance from what was typed to [word], or [max] + 1 once it
     * certainly exceeds [max]. Inserting an apostrophe is nearly free; doubling or dropping a
     * repeated letter costs half an edit.
     */
    fun distance(typed: String, word: String, max: Float, touches: List<Pt?>? = null): Float {
        val n = typed.length; val m = word.length
        if (kotlin.math.abs(n - m) > max + 1) return max + 1
        var prev2 = FloatArray(m + 1)
        var prev = FloatArray(m + 1)
        var cur = FloatArray(m + 1)
        for (j in 0..m) prev[j] = if (j == 0) 0f else prev[j - 1] + insCost(word, j - 1)
        for (i in 1..n) {
            val tc = typed[i - 1]
            cur[0] = prev[0] + delCost(typed, i - 1)
            var rowMin = cur[0]
            for (j in 1..m) {
                val wc = word[j - 1]
                var v = prev[j - 1] + substitution(tc, wc, touches?.getOrNull(i - 1))
                v = min(v, prev[j] + delCost(typed, i - 1))
                v = min(v, cur[j - 1] + insCost(word, j - 1))
                if (i > 1 && j > 1 && tc == word[j - 2] && typed[i - 2] == wc && tc != wc) v = min(v, prev2[j - 2] + TRANSPOSE)
                cur[j] = v
                if (v < rowMin) rowMin = v
            }
            if (rowMin > max) return max + 1
            val t = prev2; prev2 = prev; prev = cur; cur = t
        }
        return prev[m]
    }

    /** Distance from [typed] to the closest prefix of [word] (for completions). */
    fun prefixDistance(typed: String, word: String, max: Float): Float {
        var best = max + 1
        val lo = (typed.length - 2).coerceAtLeast(1)
        val hi = minOf(word.length, typed.length + 2)
        for (len in lo..hi) best = min(best, distance(typed, word.substring(0, len), max))
        return best
    }

    private fun insCost(w: String, j: Int): Float {
        val c = w[j]
        if (c == '\'') return 0.2f
        if (j == 0) return FIRST_LETTER_EDIT
        return if (w[j - 1] == c) 0.5f else 1f
    }

    private fun delCost(t: String, i: Int): Float {
        val c = t[i]
        if (c == '\'') return 0.4f
        if (i == 0) return FIRST_LETTER_EDIT
        return if (t[i - 1] == c) 0.5f else 1f
    }

    companion object {
        const val ADJACENT = 1.25f
        const val TRANSPOSE = 0.6f
        /** Adding or dropping the first letter is a rarer slip than one in the middle. */
        const val FIRST_LETTER_EDIT = 1.4f
        private fun pairOf(a: Char, b: Char): Int = if (a < b) (a.code shl 16) or b.code else (b.code shl 16) or a.code
        /** Hebrew final / non-final forms of the same letter. */
        private val CHEAP_PAIRS = setOf(pairOf('ם', 'מ'), pairOf('ן', 'נ'), pairOf('ץ', 'צ'), pairOf('ף', 'פ'), pairOf('ך', 'כ'))
        /** Hebrew letters that sound alike (common spelling slips). */
        private val SOUND_ALIKE = setOf(pairOf('ט', 'ת'), pairOf('כ', 'ח'), pairOf('א', 'ע'), pairOf('ק', 'כ'), pairOf('ס', 'ש'), pairOf('ב', 'ו'))
    }
}
