package com.talorys.keyboard.suggest

/**
 * Hebrew attaches function words to the front of a word: ו (and), ה (the), ב/ל/כ/מ (in, to, as,
 * from), ש/כש/מש (that, when, since) and chains of them (וכשה, ומה, שבה...). A word list can't
 * hold every combination, so prefix + known word is accepted as a word.
 */
object HebrewPrefixes {

    private val CONJ = listOf("", "ו")
    private val SUB = listOf("", "ש", "כש", "מש", "לכש")
    private val PREP = listOf("", "ה", "ב", "ל", "מ", "כ", "מה")

    /** Every valid prefix chain with its number of parts (each part is one function word). */
    val all: Map<String, Int> = buildMap {
        for (c in CONJ) for (s in SUB) for (p in PREP) {
            val pre = c + s + p
            if (pre.isEmpty()) continue
            val parts = listOf(c, s, p).count { it.isNotEmpty() } + if (p == "מה") 1 else 0
            putIfAbsent(pre, parts)
        }
    }

    private val maxLen = all.keys.maxOf { it.length }

    /** ln-probability cost of a prefix chain: each attached function word makes the form rarer. */
    fun penalty(prefix: String): Float = -PER_PART * (all[prefix] ?: 9)

    /** (prefix, stem) splits of [word], longest stem first; stems have at least [minStem] letters. */
    fun splits(word: String, minStem: Int = 2): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>(4)
        for (len in 1..minOf(maxLen, word.length - minStem)) {
            val pre = word.substring(0, len)
            if (pre in all) out += pre to word.substring(len)
        }
        return out
    }

    const val PER_PART = 2.5f
}
