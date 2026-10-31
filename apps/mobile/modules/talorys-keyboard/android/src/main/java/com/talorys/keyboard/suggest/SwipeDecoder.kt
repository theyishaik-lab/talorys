package com.talorys.keyboard.suggest

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

data class Pt(val x: Float, val y: Float)

data class SwipeCandidate(val word: String, val score: Float)

/**
 * Offline gesture ("swipe") decoder in the spirit of SHARK2: a gesture is compared with each
 * candidate word's ideal path (the polyline through its key centres).
 *
 * 1. Prune: the word must start on a key near the first touch point and end on a key near the
 *    last one, its ideal path length must be comparable with the gesture's, and every letter
 *    must pass close to the gesture.
 * 2. Location channel: both paths are resampled to [SAMPLES] equidistant points and compared
 *    point by point (in key widths).
 * 3. Shape channel: the same comparison after normalising position and scale, so a gesture
 *    drawn a little off but with the right shape still matches.
 * 4. Alignment: letters are matched to gesture points in order (dynamic programming), which
 *    rewards gestures that actually visit each key in sequence.
 * 5. The spatial cost is combined with the word's frequency prior.
 *
 * Coordinates are in pixels; [keyWidth] / [keyHeight] are the size of a letter key.
 */
class SwipeDecoder(
    private val keys: Map<Char, Pt>,
    private val keyWidth: Float,
    @Suppress("unused") private val keyHeight: Float,
) {

    /**
     * Decodes [path] against [dict]. With a [lm] the prior also uses the previous word [prev]
     * (word pairs) and the personal dictionary, whose known words are candidates too; for Hebrew,
     * prefix + word forms that the list doesn't hold are tried as well.
     */
    fun decode(
        path: List<Pt>, dict: WordDictionary, limit: Int = 5,
        lm: LanguageModel? = null, prev: String? = null,
    ): List<SwipeCandidate> {
        if (path.size < 2 || keys.isEmpty()) return emptyList()
        val gLen = length(path)
        if (gLen < keyWidth * 0.5f) return emptyList()
        val g = resample(path, SAMPLES)
        val gNorm = normalize(g)
        val turns = corners(g)

        val starts = nearKeys(path.first())
        val ends = nearKeys(path.last())
        val endKeys = ends.associate { it.first to it.second }
        val best = ArrayList<SwipeCandidate>()
        val seen = HashSet<String>()
        var checked = 0

        fun consider(word: String, endPenalty: Float, prior: () -> Float) {
            if (!seen.add(word)) return
            val pts = idealPoints(word) ?: return
            val wLen = length(pts)
            if (pts.size == 1) {
                if (gLen > keyWidth * 1.2f) return
            } else {
                val ratio = gLen / wLen
                if (ratio < 0.55f || ratio > 2.4f) return
            }
            if (!lettersNearPath(pts, g)) return
            val ideal = resample(pts, SAMPLES)
            val loc = meanDist(g, ideal) / keyWidth
            val shape = meanDist(gNorm, normalize(ideal))
            val align = alignCost(pts, g) / keyWidth
            val corner = cornerCost(turns, pts) / keyWidth
            val spatial = W_LOC * loc * loc + W_ALIGN * align * align + W_SHAPE * shape + W_END * endPenalty +
                W_DUP * collapsedRepeats(word) + W_CORNER * corner * corner
            val p = prior()
            if (!p.isFinite()) return
            insert(best, SwipeCandidate(word, -spatial + W_PRIOR * p), limit)
        }

        val prevN = prev?.takeIf { it.isNotEmpty() }?.let { if (lm?.hebrew == false) it.lowercase() else it }
        for ((sc, sd) in starts) for ((ec, ed) in ends) {
            val endPenalty = (sd + ed) / keyWidth
            for (wi in dict.withEnds(sc, ec)) {
                if (++checked > MAX_CHECK) break
                val word = dict.words[wi]
                consider(word, endPenalty) { lm?.score(word, prevN) ?: dict.logPrior[wi] }
            }
        }
        if (lm != null) {
            // Learned words, and the likely next words after the previous one.
            val extra = ArrayList<String>()
            extra += lm.learnedWords()
            if (prevN != null) extra += lm.predict(prevN, 30)
            for (w in extra) {
                if (w.isEmpty()) continue
                val sd = starts.firstOrNull { it.first == w.first() }?.second ?: continue
                val ed = endKeys[w.last()] ?: continue
                consider(w, (sd + ed) / keyWidth) { lm.score(w, prevN) }
            }
            if (lm.hebrew) decodePrefixed(dict, lm, prevN, g, starts, ends, ::consider)
        }
        return best
    }

    /**
     * Hebrew prefix chains (ו, ה, ב, ל, מ, ש, כש, וה, ...) glued to frequent stems. Only chains
     * whose letters the gesture visits are tried, and only stems starting on a key the gesture
     * passes near and ending near its last point.
     */
    private fun decodePrefixed(
        dict: WordDictionary, lm: LanguageModel, prev: String?, g: List<Pt>,
        starts: List<Pair<Char, Float>>, ends: List<Pair<Char, Float>>,
        consider: (String, Float, () -> Float) -> Unit,
    ) {
        var budget = MAX_PREFIX_CHECK
        val lim2 = (keyWidth * LETTER_REACH).let { it * it }
        val nearPath = keys.filter { (_, p) -> g.any { q -> (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y) <= lim2 } }.keys
        for ((sc, sd) in starts.take(2)) for (pre in HebrewPrefixes.all.keys) {
            if (pre.length > 4 || pre[0] != sc) continue
            val prePts = idealPoints(pre) ?: continue
            if (!lettersNearPath(prePts, g)) continue
            for (first in nearPath) for ((ec, ed) in ends.take(3)) {
                for (wi in dict.withEnds(first, ec)) {
                    if (wi > PREFIX_STEM_RANK) break
                    if (--budget < 0) return
                    val stem = dict.words[wi]
                    if (stem.length < 2) continue
                    val word = pre + stem
                    if (dict.contains(word)) continue
                    consider(word, (sd + ed) / keyWidth) { lm.score(word, prev) }
                }
            }
        }
    }

    /**
     * Sharp turns of the (resampled) gesture: where the finger changed direction by more than
     * ~55°, a key the word must visit. Words whose key path has no key near a turn are penalised
     * (shape matching alone forgives a missing corner).
     */
    internal fun corners(g: List<Pt>): List<Pt> {
        val out = ArrayList<Pt>()
        val k = 2
        var lastIdx = -10
        for (i in k until g.size - k) {
            val a = g[i - k]; val b = g[i]; val c = g[i + k]
            val v1x = b.x - a.x; val v1y = b.y - a.y
            val v2x = c.x - b.x; val v2y = c.y - b.y
            val l1 = hypot(v1x, v1y); val l2 = hypot(v2x, v2y)
            if (l1 < 1e-3f || l2 < 1e-3f) continue
            val cos = (v1x * v2x + v1y * v2y) / (l1 * l2)
            if (cos < CORNER_COS && i - lastIdx > k) {
                out += b
                lastIdx = i
            }
        }
        return out
    }

    /** Root-mean-square distance from each gesture turn to the nearest key of the word (capped). */
    private fun cornerCost(turns: List<Pt>, pts: List<Pt>): Float {
        if (turns.isEmpty()) return 0f
        val cap = keyWidth * 1.5f
        var s = 0f
        for (t in turns) {
            var m = cap
            for (p in pts) m = min(m, dist(t, p))
            s += m * m
        }
        return kotlin.math.sqrt(s / turns.size)
    }

    /** Letters dropped from the key path because they repeat ("hello" -> h-e-l-o). */
    private fun collapsedRepeats(word: String): Int {
        var n = 0
        for (i in 1 until word.length) if (word[i] == word[i - 1]) n++
        return n
    }

    // ---- helpers ----

    private fun insert(list: MutableList<SwipeCandidate>, c: SwipeCandidate, limit: Int) {
        var i = list.size
        while (i > 0 && list[i - 1].score < c.score) i--
        if (i >= limit) return
        list.add(i, c)
        if (list.size > limit) list.removeAt(list.size - 1)
    }

    /** Keys within reach of a touch point, nearest first (always at least the nearest). */
    private fun nearKeys(p: Pt): List<Pair<Char, Float>> {
        val all = keys.entries.map { it.key to hypot(it.value.x - p.x, it.value.y - p.y) }.sortedBy { it.second }
        val r = keyWidth * NEAR_RADIUS
        return all.filterIndexed { i, (_, d) -> i == 0 || d <= r }.take(MAX_NEAR)
    }

    /** Key centres for the word with consecutive repeats collapsed; null if a letter has no key. */
    internal fun idealPoints(word: String): List<Pt>? {
        val out = ArrayList<Pt>(word.length)
        var prev: Char? = null
        for (ch in word) {
            if (ch == prev) continue
            if (ch == '\'') continue // apostrophes are inserted, not swiped (don't, i'm)
            val p = keys[ch] ?: return null
            out += p
            prev = ch
        }
        return out
    }

    private fun lettersNearPath(pts: List<Pt>, g: List<Pt>): Boolean {
        val lim = keyWidth * LETTER_REACH
        val lim2 = lim * lim
        for (p in pts) {
            var ok = false
            for (q in g) {
                val dx = p.x - q.x; val dy = p.y - q.y
                if (dx * dx + dy * dy <= lim2) { ok = true; break }
            }
            if (!ok) return false
        }
        return true
    }

    /** Mean distance of an in-order assignment of letters to gesture points (first->0, last->end). */
    private fun alignCost(pts: List<Pt>, g: List<Pt>): Float {
        val n = g.size
        val m = pts.size
        if (m == 1) return dist(pts[0], g[0])
        var prev = FloatArray(n) { Float.MAX_VALUE }
        prev[0] = dist(pts[0], g[0])
        val cur = FloatArray(n)
        for (i in 1 until m) {
            var runMin = Float.MAX_VALUE
            for (j in 0 until n) {
                runMin = min(runMin, prev[j])
                cur[j] = if (runMin == Float.MAX_VALUE) Float.MAX_VALUE else runMin + dist(pts[i], g[j])
            }
            if (i == m - 1) return cur[n - 1] / m
            prev = cur.copyOf()
        }
        return prev[n - 1] / m
    }

    companion object {
        const val SAMPLES = 48
        private const val MAX_CHECK = 6000
        private const val MAX_PREFIX_CHECK = 25000
        private const val PREFIX_STEM_RANK = 30000
        private const val MAX_NEAR = 4
        private const val NEAR_RADIUS = 1.15f
        private const val LETTER_REACH = 1.1f

        // Weights (tuned with SwipeDecoderTest).
        private const val W_LOC = 2.2f
        private const val W_ALIGN = 4.0f
        private const val W_SHAPE = 2.0f
        private const val W_END = 0.6f
        private const val W_PRIOR = 0.22f
        /** Turn coverage: a gesture corner far from every key of the word. */
        private const val W_CORNER = 1.2f
        private const val CORNER_COS = 0.55f
        /** Per collapsed double letter: such a word draws the same path as its shorter twin. */
        private const val W_DUP = 0.15f

        fun dist(a: Pt, b: Pt) = hypot(a.x - b.x, a.y - b.y)

        fun length(p: List<Pt>): Float {
            var s = 0f
            for (i in 1 until p.size) s += dist(p[i - 1], p[i])
            return s
        }

        /** Resamples a polyline to [n] equidistant points (a single point is repeated). */
        fun resample(p: List<Pt>, n: Int): List<Pt> {
            if (p.isEmpty()) return emptyList()
            val total = length(p)
            if (p.size == 1 || total == 0f) return List(n) { p[0] }
            val step = total / (n - 1)
            val out = ArrayList<Pt>(n)
            out += p[0]
            var acc = 0f
            var prev = p[0]
            var i = 1
            while (i < p.size && out.size < n) {
                val cur = p[i]
                val d = dist(prev, cur)
                if (d > 0f && acc + d >= step) {
                    val t = (step - acc) / d
                    val q = Pt(prev.x + t * (cur.x - prev.x), prev.y + t * (cur.y - prev.y))
                    out += q
                    prev = q
                    acc = 0f
                } else {
                    acc += d
                    prev = cur
                    i++
                }
            }
            while (out.size < n) out += p.last()
            return out
        }

        /** Translate to the centroid and scale so the larger bounding-box side is 1. */
        fun normalize(p: List<Pt>): List<Pt> {
            var minX = Float.MAX_VALUE; var minY = Float.MAX_VALUE
            var maxX = -Float.MAX_VALUE; var maxY = -Float.MAX_VALUE
            var cx = 0f; var cy = 0f
            for (q in p) {
                minX = min(minX, q.x); maxX = max(maxX, q.x); minY = min(minY, q.y); maxY = max(maxY, q.y)
                cx += q.x; cy += q.y
            }
            cx /= p.size; cy /= p.size
            val s = max(maxX - minX, maxY - minY).let { if (abs(it) < 1e-3f) 1f else it }
            return p.map { Pt((it.x - cx) / s, (it.y - cy) / s) }
        }

        fun meanDist(a: List<Pt>, b: List<Pt>): Float {
            val n = min(a.size, b.size)
            if (n == 0) return 0f
            var s = 0f
            for (i in 0 until n) s += dist(a[i], b[i])
            return s / n
        }
    }
}
