package com.talorys.keyboard.suggest

/**
 * Tap-typing suggestions and autocorrect for one language.
 *
 * Candidates come from completions of what was typed, near-miss words (keyboard-aware weighted
 * edit distance), likely next words after the previous word, learned words, and Hebrew prefix +
 * word forms. Each is ranked by `LM score(word | previous word) - W_DIST * distance`, with a small
 * cost for completions (the user hasn't typed the rest yet).
 */
class Suggester(val lm: LanguageModel, private val prox: KeyProximity) {

    data class Candidate(val word: String, val score: Float, val distance: Float, val completion: Boolean)

    private val dict get() = lm.dict

    /** The running search's cancellation probe, per thread (the engine thread and, rarely, the main thread). */
    private val cancelProbe = ThreadLocal<(() -> Boolean)?>()

    private fun checkCancelled() {
        if (cancelProbe.get()?.invoke() == true) throw java.util.concurrent.CancellationException("superseded")
    }

    /** Apostrophe-less spelling -> most frequent word with apostrophes ("dont" -> "don't"). */
    private val contractions: Map<String, String> by lazy {
        val m = HashMap<String, String>()
        for (w in dict.words) if ('\'' in w) m.putIfAbsent(w.replace("'", ""), w)
        m
    }

    /** Lower-cases English input; Hebrew is unchanged. */
    fun normalize(typed: String): String = if (lm.hebrew) typed else typed.lowercase()

    /**
     * @param touches where each typed letter was tapped, in [KeyProximity] key units (null entries
     *   for letters that weren't tapped, e.g. picked from a popup). Feeds the spatial model.
     */
    fun candidates(
        typedRaw: String, prev: String?, limit: Int = 8, touches: List<Pt?>? = null,
        cancelled: (() -> Boolean)? = null,
    ): List<Candidate> {
        cancelProbe.set(cancelled)
        val typed = normalize(typedRaw)
        val t = touches?.takeIf { it.size == typed.length && it.any { p -> p != null } }
        if (typed.isEmpty()) return emptyList()
        val prevN = prev?.let { normalize(it) }
        val out = HashMap<String, Candidate>()
        fun add(word: String, dist: Float, completion: Boolean, completionCost: Float = W_COMPLETION) {
            val s = lm.score(word, prevN)
            if (!s.isFinite()) return
            val score = s - W_DIST * dist - if (completion) completionCost else 0f
            val old = out[word]
            if (old == null || old.score < score) out[word] = Candidate(word, score, dist, completion)
        }
        val n = typed.length

        if (lm.isValid(typed)) add(typed, 0f, false)
        for (i in dict.completionIndices(typed, 10)) dict.words[i].let { add(it, 0f, it != typed) }
        fuzzy(typed, maxDistance(n), t) { w, d -> add(w, d, false) }
        if (n >= 3) fuzzyCompletions(typed, t) { w, d -> add(w, d, true) }
        // Apostrophe-less contractions ("dont", "youre", "ill") offer the real word.
        if (!lm.hebrew) contractions[typed]?.let { add(it, 0.2f, false) }

        lm.learnedWords().forEach { w ->
            // Learned words complete without the completion cost: the user has typed them before.
            if (w.startsWith(typed)) add(w, 0f, w != typed, completionCost = 0f)
            else {
                val d = prox.distance(typed, w, maxDistance(n), t)
                if (d <= maxDistance(n)) add(w, d, false)
            }
        }
        if (!prevN.isNullOrEmpty()) for (w in lm.predict(prevN, 30)) {
            if (w.startsWith(typed)) add(w, 0f, w != typed)
            else if (n >= 3) prox.prefixDistance(typed, w, 1f).let { if (it <= 1f) add(w, it, w.length > n) }
        }
        if (lm.hebrew) {
            for ((p, s) in HebrewPrefixes.splits(typed, minStem = 1)) {
                if (s.length >= 2) for (i in dict.completionIndices(s, 10)) dict.words[i].let { add(p + it, 0f, it != s) }
                if (s.length >= 3) fuzzy(s, maxDistance(s.length) - 0.3f, t?.subList(p.length, n)) { w, d -> add(p + w, d, false) }
            }
        }
        return out.values.sortedByDescending { it.score }.take(limit)
    }

    /**
     * The correction to apply when a separator follows [typedRaw], or null to keep it. Only fires
     * when one candidate clearly beats the others and the typed text isn't itself a word.
     */
    fun autocorrect(typedRaw: String, prev: String?): String? = analyze(typedRaw, prev).autocorrect

    /** Strip candidates and the autocorrection for one input, computed together. */
    data class Analysis(val typed: String, val prev: String?, val candidates: List<Candidate>, val autocorrect: String?)

    /**
     * Candidates and autocorrection together. [cancelled] is polled during the search; when it
     * returns true the search stops with a [java.util.concurrent.CancellationException] (a newer
     * keystroke made this result useless).
     */
    fun analyze(
        typedRaw: String, prev: String?, limit: Int = 10, touches: List<Pt?>? = null,
        cancelled: (() -> Boolean)? = null,
    ): Analysis {
        val all = candidates(typedRaw, prev, maxOf(limit, 10), touches, cancelled)
        return Analysis(typedRaw, prev, all.take(limit), autocorrectFrom(typedRaw, prev, all))
    }

    /**
     * P(next letter) after [prefixRaw] (the letters typed so far in this word), for the touch
     * layer's dynamic hit boxes. At a word start it uses likely next words after [prev] and the
     * general first-letter distribution.
     */
    fun nextChars(prefixRaw: String, prev: String?): Map<Char, Float> {
        val prefix = normalize(prefixRaw)
        if (prefix.isEmpty()) {
            val preds = prev?.let { lm.predict(normalize(it), 20) }.orEmpty()
            if (preds.isEmpty()) return firstLetters
            val ctx = SpatialModel.nextCharDistribution("", preds.asSequence().mapIndexed { i, w -> w to -0.3f * i })
            return (firstLetters.keys + ctx.keys).associateWith { 0.5f * (firstLetters[it] ?: 0f) + 0.5f * (ctx[it] ?: 0f) }
        }
        val seq = dict.completionIndices(prefix, 400).asSequence().map { dict.words[it] to dict.logPrior[it] } +
            lm.learnedWords().asSequence().filter { it.startsWith(prefix) }.map { it to lm.unigram(it) }
        return SpatialModel.nextCharDistribution(prefix, seq)
    }

    private val firstLetters: Map<Char, Float> by lazy {
        SpatialModel.nextCharDistribution("", (0 until minOf(dict.size, 20_000)).asSequence().map { dict.words[it] to dict.logPrior[it] })
    }

    private fun autocorrectFrom(typedRaw: String, prev: String?, all: List<Candidate>): String? {
        val typed = normalize(typedRaw)
        val n = typed.length
        if (n < 2 || typed.any { it.isDigit() }) return null
        val cands = all.filter { !it.completion }
        val best = cands.firstOrNull() ?: return null
        if (best.word == typed) return null
        val prevN = prev?.let { normalize(it) }
        // Never "correct" a word the user has taught us (typed twice, picked, or reverted to).
        if (lm.user?.isKnown(lm.lang, typed) == true) return null
        // ...or one it keeps seeing on screen (names, product words).
        if (lm.screen?.isEligible(lm.lang, typed) == true) return null
        if (!lm.isValid(typed)) contractions[typed]?.let { return it } // dont -> don't, im -> i'm
        if (lm.isValid(typed)) {
            // A rare listed form ("teh") next to a far more likely word one cheap edit away.
            val typedScore = lm.score(typed, prevN)
            return if (best.distance <= 0.65f && best.score >= typedScore + VALID_OVERRIDE) best.word else null
        }
        val maxAuto = when {
            n == 2 -> 0.65f
            n == 3 -> 0.9f
            n <= 5 -> 1.5f
            else -> 2.0f
        }
        if (best.distance > maxAuto) return null
        if (lm.unigram(best.word) < MIN_PRIOR) return null
        val second = cands.getOrNull(1)?.score ?: Float.NEGATIVE_INFINITY
        val margin = if (best.distance <= 0.25f) 0.3f else AUTO_MARGIN
        return if (best.score - second >= margin) best.word else null
    }

    /** Words within [max] of [typed] starting with its first letter, a neighbour of it, or its second letter. */
    private fun fuzzy(typed: String, max: Float, touches: List<Pt?>? = null, emit: (String, Float) -> Unit) {
        if (typed.length < 2 || max <= 0f) return
        val n = typed.length
        val firsts = LinkedHashMap<Char, Int>()
        firsts[typed[0]] = Int.MAX_VALUE
        prox.neighbours[typed[0]]?.forEach { firsts.putIfAbsent(it, NEIGHBOUR_RANK) }
        FINAL_FORMS[typed[0]]?.let { firsts.putIfAbsent(it, NEIGHBOUR_RANK) }
        firsts.putIfAbsent(typed[1], SECOND_LETTER_RANK)
        for ((c, rankLimit) in firsts) {
            for (len in maxOf(1, n - 2)..n + 2) {
                for ((k, i) in dict.withFirstAndLength(c, len).withIndex()) {
                    if (i > rankLimit) break
                    if (k and 255 == 255) checkCancelled()
                    val w = dict.words[i]
                    val d = prox.distance(typed, w, max, touches)
                    if (d <= max) emit(w, d)
                }
            }
        }
    }

    private fun fuzzyCompletions(typed: String, touches: List<Pt?>?, emit: (String, Float) -> Unit) {
        val n = typed.length
        for ((k, i) in dict.withFirst(typed[0]).withIndex()) {
            if (i > FUZZY_COMPLETION_RANK) break
            if (k and 255 == 255) checkCancelled()
            val w = dict.words[i]
            if (w.length <= n || w.length > n + 6 || w.startsWith(typed)) continue
            val d = prox.distance(typed, w.substring(0, n), 1f, touches)
            if (d <= 1f) emit(w, d)
        }
    }

    companion object {
        const val W_DIST = 2.4f
        const val W_COMPLETION = 1.2f
        const val AUTO_MARGIN = 1.2f
        const val VALID_OVERRIDE = 6.5f
        const val MIN_PRIOR = -14f
        private const val NEIGHBOUR_RANK = 40_000
        private const val SECOND_LETTER_RANK = 15_000
        private const val FUZZY_COMPLETION_RANK = 8_000
        private val FINAL_FORMS = mapOf('ם' to 'מ', 'מ' to 'ם', 'ן' to 'נ', 'נ' to 'ן', 'ץ' to 'צ', 'צ' to 'ץ', 'ף' to 'פ', 'פ' to 'ף', 'ך' to 'כ', 'כ' to 'ך')

        fun maxDistance(n: Int): Float = when {
            n <= 2 -> 0.6f
            n == 3 -> 1.2f
            n <= 5 -> 1.7f
            else -> 2.3f
        }
    }
}
