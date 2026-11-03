package com.talorys.keyboard.suggest

import java.io.BufferedReader
import java.io.Reader
import kotlin.math.ln

/**
 * A compact frequency word list (most frequent first, so a word's index is its rank). Used for
 * tap-typing completions and corrections, and as the candidate set + language prior for gesture
 * decoding.
 *
 * File format: one `word<TAB or space>value` per line, `#` lines are comments. The value is a raw
 * count, or `round(10 * zipf)` when the file carries a `#format=zipf10` line.
 */
class WordDictionary(entries: List<Pair<String, Double>>, zipf: Boolean = false) {

    val words: Array<String> = Array(entries.size) { entries[it].first }

    /** Natural-log probability relative to the most frequent word: 0 for it, negative for the rest. */
    val logPrior: FloatArray

    /** Absolute natural-log probability of the most frequent word (to turn [logPrior] into a probability). */
    val topLogP: Float

    private val index = HashMap<String, Int>(entries.size * 2)
    private val byFirstLast = HashMap<Long, IntArray>()
    private val byFirst = HashMap<Char, IntArray>()
    private val byLast = HashMap<Char, IntArray>()
    /** (first letter, length) → indices, most frequent first: lets fuzzy search skip far lengths. */
    private val byFirstLen = HashMap<Long, IntArray>()
    /** Word indices in lexicographic order, for prefix ranges. */
    private val sorted: IntArray

    init {
        topLogP = if (zipf) (((entries.maxOfOrNull { it.second } ?: 75.0) / 10.0 - 9.0) * LN10).toFloat() else ln(0.03f)
        logPrior = if (zipf) {
            val max = entries.maxOfOrNull { it.second } ?: 0.0
            FloatArray(entries.size) { ((entries[it].second - max) / 10.0 * LN10).toFloat() }
        } else {
            val max = entries.maxOfOrNull { it.second }?.coerceAtLeast(1.0) ?: 1.0
            FloatArray(entries.size) { ln(entries[it].second.coerceAtLeast(1.0) / max).toFloat() }
        }
        val groups = HashMap<Long, MutableList<Int>>()
        val firsts = HashMap<Char, MutableList<Int>>()
        val lasts = HashMap<Char, MutableList<Int>>()
        val firstLens = HashMap<Long, MutableList<Int>>()
        words.forEachIndexed { i, w ->
            if (w.isEmpty()) return@forEachIndexed
            if (index.putIfAbsent(w, i) != null) return@forEachIndexed
            groups.getOrPut(pairKey(w.first(), w.last())) { ArrayList() } += i
            firsts.getOrPut(w.first()) { ArrayList() } += i
            lasts.getOrPut(w.last()) { ArrayList() } += i
            firstLens.getOrPut(pairKey(w.first(), minOf(w.length, 63).toChar())) { ArrayList() } += i
        }
        firstLens.forEach { (k, v) -> byFirstLen[k] = v.toIntArray() }
        groups.forEach { (k, v) -> byFirstLast[k] = v.toIntArray() }
        firsts.forEach { (k, v) -> byFirst[k] = v.toIntArray() }
        lasts.forEach { (k, v) -> byLast[k] = v.toIntArray() }
        sorted = index.values.sortedWith { a, b -> words[a].compareTo(words[b]) }.toIntArray()
    }

    val size: Int get() = words.size

    fun indexOf(word: String): Int = index[word] ?: -1
    fun contains(word: String): Boolean = index.containsKey(word)
    fun prior(word: String): Float = index[word]?.let { logPrior[it] } ?: Float.NEGATIVE_INFINITY

    /** Word indices starting with [first] and ending with [last], most frequent first. */
    fun withEnds(first: Char, last: Char): IntArray = byFirstLast[pairKey(first, last)] ?: EMPTY
    fun withFirst(first: Char): IntArray = byFirst[first] ?: EMPTY
    fun withLast(last: Char): IntArray = byLast[last] ?: EMPTY
    /** Word indices starting with [first] with exactly [length] letters, most frequent first. */
    fun withFirstAndLength(first: Char, length: Int): IntArray = byFirstLen[pairKey(first, minOf(length, 63).toChar())] ?: EMPTY

    /** Indices of words starting with [prefix], most frequent first, up to [limit]. */
    fun completionIndices(prefix: String, limit: Int): IntArray {
        if (prefix.isEmpty() || limit <= 0) return EMPTY
        var lo = 0; var hi = sorted.size
        while (lo < hi) { val mid = (lo + hi) ushr 1; if (words[sorted[mid]] < prefix) lo = mid + 1 else hi = mid }
        val start = lo
        var end = start
        while (end < sorted.size && words[sorted[end]].startsWith(prefix)) end++
        val n = end - start
        if (n == 0) return EMPTY
        if (n <= limit) return IntArray(n) { sorted[start + it] }.also { it.sort() }
        // Keep the [limit] best ranks (smallest indices) of a possibly large range.
        val best = IntArray(limit) { Int.MAX_VALUE }
        for (k in start until end) {
            val v = sorted[k]
            if (v < best[limit - 1]) {
                var j = limit - 1
                while (j > 0 && best[j - 1] > v) { best[j] = best[j - 1]; j-- }
                best[j] = v
            }
        }
        return best
    }

    /**
     * Up to [limit] most frequent words starting with [prefix] (case-sensitive; callers lower-case
     * English). The exact word, if present, is included.
     */
    fun completions(prefix: String, limit: Int): List<String> = completionIndices(prefix, limit).map { words[it] }

    companion object {
        private val EMPTY = IntArray(0)
        private val LN10 = ln(10.0)
        private fun pairKey(a: Char, b: Char): Long = (a.code.toLong() shl 32) or b.code.toLong()

        fun load(reader: Reader, limit: Int = Int.MAX_VALUE): WordDictionary {
            val list = ArrayList<Pair<String, Double>>()
            var zipf = false
            BufferedReader(reader).useLines { lines ->
                for (line in lines) {
                    if (list.size >= limit) break
                    if (line.isBlank()) continue
                    if (line.startsWith("#")) { if (line.startsWith("#format=zipf10")) zipf = true; continue }
                    val sep = line.indexOfFirst { it == '\t' || it == ' ' }
                    if (sep <= 0) continue
                    val w = line.substring(0, sep)
                    val c = line.substring(sep + 1).trim().toDoubleOrNull() ?: 1.0
                    list += w to c
                }
            }
            return WordDictionary(list, zipf)
        }
    }
}
