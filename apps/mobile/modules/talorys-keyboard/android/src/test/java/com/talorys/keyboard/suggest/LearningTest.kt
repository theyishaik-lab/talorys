package com.talorys.keyboard.suggest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LearningTest {

    private var now = 1_000_000L
    private fun store(file: File? = null) = UserDictionary(file) { now }

    @Test fun wordBecomesKnownAfterTwoUsesAndStopsBeingCorrected() {
        val u = store()
        val s = TestData.enSuggester(u)
        val before = s.autocorrect("talorys", null)
        u.learn("en", "talorys", null)
        assertFalse(u.isKnown("en", "talorys"))
        u.learn("en", "talorys", null)
        assertTrue(u.isKnown("en", "talorys"))
        assertNull("was $before", s.autocorrect("talorys", null))
        assertEquals("talorys", s.candidates("talor", null).first().word)
        assertTrue("talorys" in s.candidates("talo", null).take(3).map { it.word })
    }

    @Test fun explicitAcceptIsKnownAtOnce() {
        val u = store()
        u.learn("he", "טלוריס", null, UserDictionary.EXPLICIT_WEIGHT)
        assertTrue(TestData.heModel(u).isValid("טלוריס"))
        // and with a Hebrew prefix
        assertTrue(TestData.heModel(u).isValid("ובטלוריס"))
    }

    @Test fun learnedPairsDrivePrediction() {
        val u = store()
        repeat(3) { u.learn("en", "mewtwo", "pokemon") }
        repeat(3) { u.learn("en", "pokemon", null) }
        assertEquals("mewtwo", TestData.enModel(u).predict("pokemon").first())
        // learned pair also lifts the word in suggestions after that word
        assertEquals("mewtwo", TestData.enSuggester(u).candidates("mew", "pokemon").first().word)
    }

    @Test fun removeForgetsWordAndPairs() {
        val u = store()
        repeat(2) { u.learn("en", "zorbo", "big") }
        assertTrue(u.remove("en", "zorbo"))
        assertFalse(u.isKnown("en", "zorbo"))
        assertTrue(u.nextWords("en", "big").isEmpty())
        val snap = u.snapshot()
        assertTrue(snap.words.single { it.w == "zorbo" }.isDeleted)
        assertTrue(snap.bigrams.single().isDeleted)
        assertFalse(u.remove("en", "never-learned"))
        // learning it again resurrects it
        now += 10
        repeat(2) { u.learn("en", "zorbo", null) }
        assertTrue(u.isKnown("en", "zorbo"))
    }

    @Test fun clearAllLeavesTombstones() {
        val u = store()
        u.learn("en", "alpha", "x"); u.learn("he", "שלום", null)
        u.clearAll()
        assertEquals(0, u.learnedWordCount())
        assertTrue(u.snapshot().words.all { it.isDeleted })
        assertTrue(u.snapshot().bigrams.all { it.isDeleted })
    }

    @Test fun neverLearnsJunk() {
        val u = store()
        u.learn("en", "abc123", null); u.learn("en", "", null); u.learn("en", "'quoted", null)
        assertEquals(0, u.learnedWordCount())
    }

    @Test fun persistsToFile() {
        val f = File.createTempFile("learned", ".json")
        f.delete()
        val u = store(f)
        repeat(2) { u.learn("he", "קפוצ'ינו", "עוד") }
        u.flush()
        val again = store(f)
        assertTrue(again.isKnown("he", "קפוצ'ינו"))
        assertEquals(2L, again.bigramCount("he", "עוד", "קפוצ'ינו"))
        f.delete()
    }
}
