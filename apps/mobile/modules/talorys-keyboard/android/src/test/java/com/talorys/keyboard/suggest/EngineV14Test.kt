package com.talorys.keyboard.suggest

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executors
import kotlinx.coroutines.asCoroutineDispatcher

/** 1.4.0 engine behaviour: spatial evidence, contractions, learned words, Hebrew prefixes, next letters, async runner. */
class EngineV14Test {

    private val en = TestData.enSuggester()
    private val he = TestData.heSuggester()
    private val prox = KeyProximity(TestData.enKeys.first, TestData.enKeys.second)

    private fun touchesOn(word: String, override: Map<Int, Pt> = emptyMap()): List<Pt?> =
        word.mapIndexed { i, c -> override[i] ?: prox.keyUnits[c] }

    @Test fun touchOnTheBorderMakesTheNeighbourCheap() {
        val k = prox.keyUnits
        // Typed "rhe" for "the": the 'r' tap hit the r|t border.
        val border = Pt((k['r']!!.x + k['t']!!.x) / 2f, k['r']!!.y)
        val withTouch = prox.distance("rhe", "the", 2f, touchesOn("rhe", mapOf(0 to border)))
        val centre = prox.distance("rhe", "the", 2f, touchesOn("rhe"))
        val none = prox.distance("rhe", "the", 2f)
        assertTrue("border $withTouch < centre $centre", withTouch < centre)
        assertEquals(none, centre, 0.11f)
    }

    @Test fun spatialEvidenceRaisesTheIntendedWord() {
        val k = prox.keyUnits
        // "gat" with the first tap on the g|h border: "hat" gains against the same input tapped dead centre.
        val border = Pt((k['g']!!.x + k['h']!!.x) / 2f, k['g']!!.y)
        fun scoreOf(t: List<Pt?>?) = en.candidates("gat", null, 20, t).firstOrNull { it.word == "hat" }?.score ?: Float.NEGATIVE_INFINITY
        val withBorder = scoreOf(touchesOn("gat", mapOf(0 to border)))
        val centred = scoreOf(touchesOn("gat"))
        assertTrue("border $withBorder > centre $centred", withBorder > centred + 0.5f)
        // And a typo whose tap was on the border is corrected: "rhe" → "the".
        val rBorder = Pt((k['r']!!.x + k['t']!!.x) / 2f, k['r']!!.y)
        assertEquals("the", en.analyze("rhe", null, 6, touchesOn("rhe", mapOf(0 to rBorder))).autocorrect)
    }

    @Test fun contractionsAreOffered() {
        val c = en.candidates("dont", null).map { it.word }
        assertTrue("don't in $c", "don't" in c.take(3))
        val y = en.candidates("youre", null).map { it.word }
        assertTrue("you're in $y", "you're" in y.take(3))
    }

    @Test fun learnedWordsAreNeverCorrected() {
        val u = UserDictionary(null) { 1L }
        val s = TestData.enSuggester(u)
        assertEquals("the", s.autocorrect("teh", null))
        repeat(2) { u.learn("en", "teh", null) }
        assertNull(s.autocorrect("teh", null))
    }

    @Test fun hebrewPrefixSuggestions() {
        for ((typed, want) in listOf("והמשפ" to "והמשפחה", "כשהמחש" to "כשהמחשב", "ובבקש" to "ובבקשה", "שהעבו" to "שהעבודה")) {
            val c = he.candidates(typed, null).map { it.word }
            println("$typed → ${c.take(5)}")
            assertTrue("$want in $c", want in c.take(3))
        }
        // The prefixed word itself is in the list and stays visible among the candidates.
        assertTrue("ושלום" in he.candidates("ושלו", null).map { it.word })
    }

    @Test fun nextLetterProbabilities() {
        val d = en.nextChars("th", null)
        val top = d.maxByOrNull { it.value }!!.key
        assertEquals('e', top)
        assertTrue(d.values.sum() in 0.99f..1.01f)
        val first = en.nextChars("", null)
        assertTrue((first['t'] ?: 0f) > (first['z'] ?: 0f))
        val h = he.nextChars("של", null)
        assertTrue("ו likely after של: $h", (h['ו'] ?: 0f) > 0.05f)
    }

    @Test fun emojiTable() {
        assertEquals("❤️", EmojiSuggestions.forWord("Love", hebrew = false))
        assertEquals("❤️", EmojiSuggestions.forWord("ואוהב", hebrew = true))
        assertNull(EmojiSuggestions.forWord("keyboard", hebrew = false))
    }

    @Test fun suggestionsAreFastEnoughForABackgroundThread() {
        // Warm up, then time a burst of keystrokes (desktop JVM; a phone is ~5-10x slower).
        val words = listOf("t", "th", "the", "thi", "thin", "think", "s", "so", "som", "some", "somet", "someth")
        repeat(2) { words.forEach { en.analyze(it, "i", 6) } }
        val t0 = System.nanoTime()
        words.forEach { en.analyze(it, "i", 6) }
        val t1 = System.nanoTime()
        words.forEach { en.nextChars(it, "i") }
        val t2 = System.nanoTime()
        val perKeyMs = (t2 - t0) / 1e6 / words.size
        println("per keystroke: analyze %.2f ms, nextChars %.2f ms".format((t1 - t0) / 1e6 / words.size, (t2 - t1) / 1e6 / words.size))
        assertTrue("per keystroke $perKeyMs ms", perKeyMs < 40)
    }

    @Test fun latestRunnerDeliversOnlyTheNewest() = runBlocking {
        val worker = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
        val delivered = ArrayList<Int>()
        val runner = LatestRunner(this, worker, debounceMs = 5)
        for (i in 1..5) runner.submit({ _ -> Thread.sleep(2); i }) { delivered += it }
        delay(200)
        assertEquals(listOf(5), delivered)
        runner.submit({ _ -> 6 }) { delivered += it }
        runner.cancel()
        delay(50)
        assertEquals(listOf(5), delivered)
        worker.close()
    }

    @Test fun supersededSearchStopsEarly() {
        var polls = 0
        try {
            en.analyze("somethin", null, 6, null) { polls++; true }
            org.junit.Assert.fail("expected cancellation")
        } catch (_: java.util.concurrent.CancellationException) {
        }
        assertTrue(polls >= 1)
        // A search that isn't cancelled still completes normally afterwards.
        assertTrue(en.analyze("somethin", null, 6).candidates.any { it.word == "something" })
    }

    @Test fun lruCacheEvicts() {
        val c = LruCache<String, Int>(2)
        c["a"] = 1; c["b"] = 2; c["a"]; c["c"] = 3
        assertEquals(1, c["a"]); assertNull(c["b"]); assertEquals(3, c["c"])
    }

    @Test fun decoderFindsTurns() {
        val dec = SwipeDecoderTest.decoderFor(com.talorys.keyboard.keyboard.Layouts.english(com.talorys.keyboard.keyboard.FieldFlavor.TEXT, true))
        val g = SwipeDecoder.resample(dec.idealPoints("hello")!!, SwipeDecoder.SAMPLES)
        // h → e → l → o turns at e and at l.
        assertTrue(dec.corners(g).size >= 2)
        val straight = SwipeDecoder.resample(listOf(Pt(0f, 0f), Pt(500f, 0f)), SwipeDecoder.SAMPLES)
        assertEquals(0, dec.corners(straight).size)
    }
}
