package com.talorys.keyboard.suggest

import kotlin.math.exp
import kotlin.math.ln

/**
 * Word probabilities for one language: built-in frequencies, Hebrew prefix forms, built-in word
 * pairs and the personal dictionary (learned words and pairs).
 *
 * Scores are natural logs relative to the most frequent built-in word, so a word with no context
 * scores its [WordDictionary.logPrior].
 */
class LanguageModel(
    val dict: WordDictionary,
    val bigrams: Bigrams = Bigrams.EMPTY,
    val user: UserDictionary? = null,
    val lang: String = "en",
    /** Words learned from the screen (opt-in): offered at low weight until the user types one. */
    val screen: com.talorys.keyboard.screen.ScreenLexicon? = null,
) {
    val hebrew: Boolean get() = lang == "he"

    /** Is [word] a real word (built-in, learned, or a Hebrew prefix + known word)? */
    fun isValid(word: String): Boolean {
        if (dict.contains(word) || user?.isKnown(lang, word) == true || screen?.isEligible(lang, word) == true) return true
        if (!hebrew) return false
        return HebrewPrefixes.splits(word).any { (_, s) -> dict.contains(s) || user?.isKnown(lang, s) == true || screen?.isEligible(lang, s) == true }
    }

    /** Learned words to consider as candidates: typed (known) words, then eligible screen words. */
    fun learnedWords(): List<String> {
        val typed = user?.knownWords(lang)?.map { it.w }.orEmpty()
        val seen = screen?.eligibleWords(lang).orEmpty()
        if (seen.isEmpty()) return typed
        val set = HashSet(typed)
        return typed + seen.filter { set.add(it) }
    }

    /** Context-free log score, or -inf for an unknown word. */
    fun unigram(word: String): Float {
        var best = dict.prior(word)
        val u = user?.count(lang, word) ?: 0
        if (u > 0) {
            best = if (best.isFinite()) best + USER_BOOST * ln(1f + u)
            else if (u >= UserDictionary.KNOWN_COUNT) LEARNED_BASE + USER_BOOST * ln(1f + u) else best
        }
        if (u < UserDictionary.KNOWN_COUNT && screen?.isEligible(lang, word) == true) {
            // Seen on screen but never typed: rarer than a typed word; a built-in word only gets a nudge.
            best = if (best.isFinite()) best + SCREEN_BOOST else maxOf(best, SCREEN_BASE)
        }
        if (hebrew) {
            for ((p, s) in HebrewPrefixes.splits(word)) {
                val sp = dict.prior(s).let { if (it.isFinite()) it else if (user?.isKnown(lang, s) == true) LEARNED_BASE else it }
                if (sp.isFinite()) best = maxOf(best, sp + HebrewPrefixes.penalty(p))
            }
        }
        return best
    }

    /** ln P(word | prev) from built-in and learned pairs, -inf when the pair is unseen. */
    private fun pairProb(prev: String, word: String): Double {
        var p = 0.0
        val b = bigrams.logP(prev, word)
        if (b.isFinite()) p += BUILTIN_PAIR_WEIGHT * exp(b.toDouble())
        val u = user
        if (u != null) {
            val c = u.bigramCount(lang, prev, word)
            if (c > 0) {
                val total = u.nextWords(lang, prev).sumOf { it.second }
                p += USER_PAIR_WEIGHT * c / (total + 1.0)
            }
        }
        return p
    }

    /** Score of [word] after [prev]: interpolates the unigram with the pair probabilities. */
    fun score(word: String, prev: String?): Float {
        val uni = unigram(word)
        if (prev.isNullOrEmpty()) return uni
        var pair = pairProb(prev, word)
        if (pair == 0.0 && hebrew) {
            // "ובבית" -> look at pairs of its stem "בבית" / "בית".
            for ((_, s) in HebrewPrefixes.splits(prev)) { pair = pairProb(s, word); if (pair > 0) { pair *= 0.5; break } }
        }
        if (pair == 0.0) return uni
        val uniAbs = if (uni.isFinite()) exp((uni + dict.topLogP).toDouble()) else 0.0
        return (ln(uniAbs + pair) - dict.topLogP).toFloat()
    }

    /** Next-word predictions after [prev], best first. */
    fun predict(prev: String, limit: Int = 3): List<String> {
        val scores = HashMap<String, Double>()
        fun collect(p: String, factor: Double) {
            bigrams.successors(p)?.let { s -> for (i in s.words.indices) scores.merge(s.words[i], factor * BUILTIN_PAIR_WEIGHT * exp(s.logP[i].toDouble()), Double::plus) }
            user?.let { u ->
                val next = u.nextWords(lang, p)
                val total = next.sumOf { it.second } + 1.0
                for ((w, c) in next) scores.merge(w, factor * USER_PAIR_WEIGHT * c / total, Double::plus)
            }
        }
        collect(prev, 1.0)
        if (scores.isEmpty() && hebrew) HebrewPrefixes.splits(prev).firstOrNull { bigrams.successors(it.second) != null }?.let { collect(it.second, 0.5) }
        return scores.entries.sortedByDescending { it.value }.take(limit).map { it.key }
    }

    companion object {
        const val USER_BOOST = 0.6f
        /** A learned word that isn't built in scores like a moderately rare word. */
        const val LEARNED_BASE = -7.5f
        /** A word only seen on screen scores below a typed one. */
        const val SCREEN_BASE = -9.0f
        const val SCREEN_BOOST = 0.15f
        const val BUILTIN_PAIR_WEIGHT = 0.5
        const val USER_PAIR_WEIGHT = 0.8
    }
}
