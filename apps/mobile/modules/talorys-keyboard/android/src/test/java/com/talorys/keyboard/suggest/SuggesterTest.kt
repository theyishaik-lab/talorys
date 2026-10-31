package com.talorys.keyboard.suggest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class SuggesterTest {

    private val en = TestData.enSuggester()
    private val he = TestData.heSuggester()

    @Test fun englishTyposAreAutocorrected() {
        val cases = mapOf(
            "teh" to "the", "becuase" to "because", "dont" to "don't", "im" to "i'm", "recieve" to "receive",
            "keybaord" to "keyboard", "tomorow" to "tomorrow", "peopel" to "people", "wrold" to "world",
            "thnks" to "thanks", "realy" to "really", "beleive" to "believe", "cant" to "can't",
        )
        val wrong = cases.filter { (typo, want) -> en.autocorrect(typo, null) != want }
            .map { (typo, want) -> "$typo→${en.autocorrect(typo, null)} (want $want)" }
        println("en autocorrect misses: $wrong")
        assertTrue("misses: $wrong", wrong.size <= 1)
    }

    @Test fun validWordsAreNeverCorrected() {
        for (w in listOf("hello", "the", "because", "keyboard", "its", "were", "well", "i", "a", "ok", "gonna", "instagram"))
            assertNull("en $w", en.autocorrect(w, null))
        for (w in listOf("שלום", "בית", "תודה", "ובבית", "וכשהבית", "שהמחשב", "ולמשפחה", "כשהילדים", "ומה"))
            assertNull("he $w", he.autocorrect(w, null))
    }

    @Test fun hebrewTyposAreAutocorrected() {
        assertEquals("שלום", he.autocorrect("שלומ", null))
        assertEquals("תודה", he.autocorrect("תודע", null) ?: he.autocorrect("תודח", null))
        // Prefix + misspelt word keeps the prefix.
        assertEquals("ושלום", he.autocorrect("ושלומ", null))
        assertEquals("כשהמחשב", he.autocorrect("כשהמחדב", null))
    }

    @Test fun noCorrectionForShortAmbiguousOrDigitWords() {
        assertNull(en.autocorrect("x", null))
        assertNull(en.autocorrect("abc1", null))
        assertNull(en.autocorrect("qzxv", null)) // nothing close: keep it
    }

    /** Synthetic neighbour-key typos on frequent words: mostly fixed, rarely made worse. */
    @Test fun syntheticNeighbourTypos() {
        for ((name, s, dict) in listOf(Triple("en", en, TestData.en), Triple("he", he, TestData.he))) {
            val prox = KeyProximity(if (name == "en") TestData.enKeys.first else TestData.heKeys.first,
                if (name == "en") TestData.enKeys.second else TestData.heKeys.second)
            val rnd = Random(5)
            val words = (200 until 3000).map { dict.words[it] }.filter { it.length >= 5 && it.all { c -> c in prox.neighbours } }.shuffled(rnd).take(150)
            var fixed = 0; var worse = 0; var total = 0
            val bad = ArrayList<String>()
            for (w in words) {
                val i = 1 + rnd.nextInt(w.length - 2)
                val nb = prox.neighbours[w[i]] ?: continue
                val typo = w.substring(0, i) + nb[rnd.nextInt(nb.size)] + w.substring(i + 1)
                if (s.lm.isValid(typo)) continue
                total++
                when (s.autocorrect(typo, null)) {
                    w -> fixed++
                    null -> {}
                    else -> { worse++; bad += "$typo→${s.autocorrect(typo, null)}($w)" }
                }
            }
            println("$name synthetic typos: fixed $fixed/$total, wrong $worse: ${bad.take(15)}")
            assertTrue("$name fixed $fixed/$total", fixed >= total * 0.55)
            assertTrue("$name wrong $worse/$total", worse <= total * 0.15)
        }
    }

    @Test fun completionsAndCorrectionsRankByFrequencyAndDistance() {
        val c = en.candidates("hel", null).map { it.word }
        assertTrue(c.toString(), "hello" in c.take(4) || "help" in c.take(4))
        val k = en.candidates("keyboa", null).map { it.word }
        assertEquals("keyboard", k.first())
    }

    @Test fun previousWordChangesTheRanking() {
        val plain = en.candidates("y", null).map { it.word }
        val afterThank = en.candidates("y", "thank").map { it.word }
        assertEquals("you", afterThank.first())
        assertTrue(plain.isNotEmpty())
        val heAfter = he.candidates("ט", "בוקר").map { it.word }
        assertEquals("טוב", heAfter.first())
    }

    @Test fun hebrewPrefixesComplete() {
        val c = he.candidates("ובבי", null).map { it.word }
        assertTrue(c.toString(), "ובבית" in c)
        val d = he.candidates("כשהמחש", null).map { it.word }
        assertTrue(d.toString(), "כשהמחשב" in d)
        assertTrue(he.lm.isValid("וכשהמחשב"))
        assertTrue(!he.lm.isValid("וכשהקקקק"))
    }

    @Test fun nextWordPrediction() {
        assertTrue(TestData.enModel().predict("thank").contains("you"))
        assertTrue(TestData.heModel().predict("בוקר").contains("טוב"))
        assertTrue(TestData.enModel().predict("zzzzqq").isEmpty())
    }

    @Test fun prefixSplits() {
        assertEquals(listOf("ו" to "כשהבית", "וכ" to "שהבית", "וכש" to "הבית", "וכשה" to "בית"), HebrewPrefixes.splits("וכשהבית"))
        assertTrue(HebrewPrefixes.splits("שלום").map { it.first } == listOf("ש", "של"))
        assertTrue(HebrewPrefixes.penalty("ו") > HebrewPrefixes.penalty("וכשה"))
    }

    @Test fun distanceIsKeyboardAware() {
        val p = KeyProximity(TestData.enKeys.first, TestData.enKeys.second)
        assertTrue(p.distance("tge", "the", 3f) < p.distance("tpe", "the", 3f)) // g is next to h, p isn't
        assertEquals(0.6f, p.distance("teh", "the", 3f), 0.01f)
        assertEquals(0.2f, p.distance("dont", "don't", 3f), 0.01f)
        assertEquals(0.5f, p.distance("tomorow", "tomorrow", 3f), 0.01f)
    }
}
