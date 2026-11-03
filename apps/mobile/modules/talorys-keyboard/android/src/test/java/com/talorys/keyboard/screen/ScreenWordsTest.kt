package com.talorys.keyboard.screen

import com.talorys.keyboard.suggest.LanguageModel
import com.talorys.keyboard.suggest.LearnedWord
import com.talorys.keyboard.suggest.UserDictionary
import com.talorys.keyboard.suggest.WordDictionary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class ScreenTokenizerTest {

    private fun words(text: String) = ScreenTokenizer.tokenize(text).map { "${it.lang}:${it.word}" }

    @Test fun splitsHebrewAndEnglish() {
        assertEquals(listOf("en:meeting", "en:with", "he:טלוריס", "he:מחר", "en:tomorrow"), words("Meeting with טלוריס מחר, tomorrow!"))
    }

    @Test fun dropsUrlsEmailsHandlesAndNumbers() {
        val t = words("Visit https://talorys.dev/x?y=1 or www.example.com, mail yishai@example.co.il @handle #tag 2026 abc123 v1.4 call")
        assertEquals(listOf("en:visit", "en:mail", "en:call"), t)
    }

    @Test fun dropsShortLongMixedAndAcronyms() {
        assertEquals(emptyList<String>(), words("ok a an HTTP SALE abcdefghijklmnopqrstuvwxyzab helloשלום aaaa"))
        assertNull(ScreenTokenizer.classify("ab"))
        assertNull(ScreenTokenizer.classify("x".repeat(25)))
    }

    @Test fun stripsNiqqudAndKeepsInnerApostrophe() {
        assertEquals(listOf("he:שלום", "en:don't"), words("שָׁלוֹם Don’t"))
        assertNull(ScreenTokenizer.classify("'quoted"))
    }
}

class ScreenWordStoreTest {

    private var now = 1_000L
    private fun store() = ScreenWordStore(clock = { now })
    private fun tok(vararg w: String) = w.map { ScreenToken(if (it.first() in 'א'..'ת') "he" else "en", it) }

    @Test fun eligibleOnlyAfterThreeDistinctScreens() {
        val s = store()
        s.recordEvent(1, tok("talorys"))
        s.recordEvent(1, tok("talorys")) // same screen re-read
        s.recordEvent(2, tok("talorys", "talorys")) // twice on one screen counts once
        assertFalse(s.isEligible("en", "talorys"))
        assertEquals(1, s.recordEvent(3, tok("talorys")))
        assertTrue(s.isEligible("en", "talorys"))
        assertEquals(listOf("talorys"), s.eligibleWords("en"))
        assertEquals(listOf("talorys"), s.learned().map { it.w })
    }

    @Test fun skipsMainDictionaryWords() {
        val s = store()
        s.isMainWord = { _, w -> w == "meeting" || w == "בית" }
        for (e in 1L..3L) s.recordEvent(e, tok("meeting", "talorys", "בבית"))
        assertFalse(s.isEligible("en", "meeting"))
        assertFalse(s.isEligible("he", "בבית")) // prefix + built-in word
        assertTrue(s.isEligible("en", "talorys"))
    }

    @Test fun prunesWordsRecordedBeforeDictionariesLoaded() {
        val s = store()
        for (e in 1L..3L) s.recordEvent(e, tok("meeting", "talorys"))
        s.isMainWord = { _, w -> w == "meeting" }
        assertEquals(1, s.pruneKnown())
        assertEquals(listOf("talorys"), s.learned().map { it.w })
    }

    @Test fun hebrewPrefixCountsTowardTrackedStem() {
        val s = store()
        s.recordEvent(1, tok("לטלוריס")) // stem not tracked yet: kept as is
        s.recordEvent(2, tok("טלוריס")) // bare stem absorbs the prefixed sighting
        s.recordEvent(3, tok("וטלוריס")) // now strips to the stem
        assertTrue(s.isEligible("he", "טלוריס"))
        assertFalse(s.isEligible("he", "לטלוריס"))
        // An ordinary first letter is not stripped when the remainder isn't tracked.
        for (e in 4L..6L) s.recordEvent(e, tok("בלורית"))
        assertTrue(s.isEligible("he", "בלורית"))
    }

    @Test fun deleteIsRememberedAndClearAllForgets() {
        val s = store()
        for (e in 1L..3L) s.recordEvent(e, tok("talorys", "gizmo"))
        assertTrue(s.remove("en", "talorys"))
        for (e in 4L..9L) s.recordEvent(e, tok("talorys"))
        assertFalse(s.isEligible("en", "talorys"))
        s.clearAll()
        assertTrue(s.learned().isEmpty())
        assertEquals(0, s.pendingCount())
        // Deletions are exported so the backup forgets them too.
        assertTrue(s.exportForBackup().all { it.isDeleted })
    }

    @Test fun promoteMovesWordOut() {
        val s = store()
        for (e in 1L..3L) s.recordEvent(e, tok("talorys"))
        assertTrue(s.promote("en", "talorys"))
        assertFalse(s.isEligible("en", "talorys"))
        assertFalse(s.promote("en", "unknownword"))
    }

    @Test fun persistsAndMergesBackup() {
        val f = File.createTempFile("screen", ".json").also { it.delete() }
        try {
            val a = ScreenWordStore(f, clock = { now })
            for (e in 1L..3L) a.recordEvent(e, tok("talorys"))
            a.flush()
            val b = ScreenWordStore(f, clock = { now })
            assertTrue(b.isEligible("en", "talorys"))
            b.mergeBackup(listOf(LearnedWord("gizmo", "en", 4, 5), LearnedWord("talorys", "en", 1, 9_999, deleted = true)))
            assertTrue(b.isEligible("en", "gizmo"))
            assertFalse(b.isEligible("en", "talorys"))
        } finally { f.delete() }
    }
}

class ScreenPolicyTest {
    @Test fun excludesOwnSystemListedAndSensitiveApps() {
        val list = ScreenPolicy.DEFAULT_EXCLUDED
        assertTrue(ScreenPolicy.isExcluded("com.talorys.keyboard", emptyList()))
        assertTrue(ScreenPolicy.isExcluded("dev.talorys.app", emptyList()))
        assertTrue(ScreenPolicy.isExcluded("com.android.systemui", emptyList()))
        assertTrue(ScreenPolicy.isExcluded("com.x8bit.bitwarden", list))
        assertTrue(ScreenPolicy.isExcluded("com.example.mybank", emptyList()))
        assertTrue(ScreenPolicy.isExcluded("org.some.passwordsafe", emptyList()))
        assertTrue(ScreenPolicy.isExcluded(null, list))
        assertFalse(ScreenPolicy.isExcluded("org.telegram.messenger", list))
        assertTrue(ScreenPolicy.isExcluded("org.telegram.messenger", listOf("org.telegram.messenger")))
    }

    @Test fun parsesUserList() {
        assertEquals(listOf("com.a.b", "org.c.d"), ScreenPolicy.parseList("com.a.b\n  org.c.d, junk, com.a.b\n\n"))
    }
}

class ScreenLexiconModelTest {
    @Test fun screenWordsScoreBelowTypedWordsAndPromoteOnTyping() {
        val dict = WordDictionary(listOf("the" to 1000.0, "meeting" to 50.0))
        val user = UserDictionary()
        val screen = ScreenWordStore()
        val lm = LanguageModel(dict, user = user, lang = "en", screen = screen)
        assertFalse(lm.isValid("talorys"))
        for (e in 1L..3L) screen.recordEvent(e, listOf(ScreenToken("en", "talorys")))
        assertTrue(lm.isValid("talorys"))
        assertTrue("talorys" in lm.learnedWords())
        val seenScore = lm.unigram("talorys")
        assertEquals(LanguageModel.SCREEN_BASE, seenScore, 0.001f)
        // Typed twice -> a known personal word, which outranks a screen-only word.
        user.learn("en", "gizmo", null); user.learn("en", "gizmo", null)
        assertTrue(lm.unigram("gizmo") > seenScore)
        // Promotion: the screen store lets go, the personal dictionary keeps it.
        assertTrue(screen.promote("en", "talorys"))
        user.learn("en", "talorys", null, UserDictionary.KNOWN_COUNT.toInt())
        assertTrue(user.isKnown("en", "talorys"))
        assertFalse(screen.isEligible("en", "talorys"))
    }
}
