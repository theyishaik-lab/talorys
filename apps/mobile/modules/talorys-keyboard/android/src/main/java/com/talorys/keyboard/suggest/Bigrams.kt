package com.talorys.keyboard.suggest

import java.io.BufferedReader
import java.io.Reader
import kotlin.math.ln

/**
 * Built-in word pairs: for a previous word, its most common next words with ln P(next | prev).
 * File format: `prev<TAB>total<TAB>next:count next:count ...`, `#` lines are comments.
 */
class Bigrams(private val map: Map<String, Successors>) {

    class Successors(val words: Array<String>, val logP: FloatArray) {
        fun logP(word: String): Float {
            for (i in words.indices) if (words[i] == word) return logP[i]
            return Float.NEGATIVE_INFINITY
        }
    }

    fun successors(prev: String): Successors? = map[prev]
    fun logP(prev: String, next: String): Float = map[prev]?.logP(next) ?: Float.NEGATIVE_INFINITY
    val size: Int get() = map.size

    companion object {
        val EMPTY = Bigrams(emptyMap())

        fun load(reader: Reader): Bigrams {
            val map = HashMap<String, Successors>()
            BufferedReader(reader).useLines { lines ->
                for (line in lines) {
                    if (line.isBlank() || line.startsWith("#")) continue
                    val p = line.split('\t')
                    if (p.size < 3) continue
                    val total = p[1].toDoubleOrNull()?.coerceAtLeast(1.0) ?: continue
                    val items = p[2].split(' ').mapNotNull { s ->
                        val c = s.lastIndexOf(':')
                        if (c <= 0) null else s.substring(0, c) to (s.substring(c + 1).toDoubleOrNull() ?: return@mapNotNull null)
                    }
                    if (items.isEmpty()) continue
                    map[p[0]] = Successors(
                        Array(items.size) { items[it].first },
                        FloatArray(items.size) { ln(items[it].second / total).toFloat() },
                    )
                }
            }
            return Bigrams(map)
        }

        fun of(vararg pairs: Pair<String, List<Pair<String, Int>>>): Bigrams = Bigrams(pairs.associate { (prev, nexts) ->
            val total = nexts.sumOf { it.second }.toDouble()
            prev to Successors(nexts.map { it.first }.toTypedArray(), FloatArray(nexts.size) { ln(nexts[it].second / total).toFloat() })
        })
    }
}
