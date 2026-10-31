package com.talorys.keyboard.suggest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WordLogicTest {
    @Test fun trailingWord() {
        assertEquals("wor", WordLogic.trailingWord("hello wor"))
        assertEquals("", WordLogic.trailingWord("hello "))
        assertEquals("שלו", WordLogic.trailingWord("מה שלו"))
        assertEquals("", WordLogic.trailingWord(null))
    }

    @Test fun spacing() {
        assertTrue(WordLogic.needsSpaceBefore('a'))
        assertTrue(WordLogic.needsSpaceBefore('.'))
        assertTrue(WordLogic.needsSpaceBefore('ם'))
        assertFalse(WordLogic.needsSpaceBefore(' '))
        assertFalse(WordLogic.needsSpaceBefore('('))
        assertFalse(WordLogic.needsSpaceBefore(null))
    }

    @Test fun casing() {
        assertEquals("Hello", WordLogic.matchCase("hello", "He", english = true))
        assertEquals("HELLO", WordLogic.matchCase("hello", "HE", english = true))
        assertEquals("I", WordLogic.matchCase("i", "", english = true))
        assertEquals("Hello", WordLogic.matchCase("hello", "", english = true, shiftOn = true))
        assertEquals("שלום", WordLogic.matchCase("שלום", "של", english = false, shiftOn = true))
    }

    @Test fun arrangeKeepsLiteralWhenNotACandidate() {
        assertEquals(listOf("thx", "the", "that"), WordLogic.arrange("thx", listOf("the", "that")))
        assertEquals(listOf("then", "the", "there"), WordLogic.arrange("the", listOf("the", "then", "there")))
        assertEquals(listOf(null, "zzq", null), WordLogic.arrange("zzq", emptyList()))
    }
}

class WordLogicContextTest {
    @Test fun apostrophesAndDigits() {
        assertEquals("don't", WordLogic.trailingWord("I don't"))
        assertEquals("abc1", WordLogic.trailingWord("x abc1"))
        assertEquals("", WordLogic.trailingWord("x 123"))
        assertTrue(WordLogic.hasDigit("abc1"))
    }

    @Test fun previousWords() {
        assertEquals("thank", WordLogic.previousWord("thank "))
        assertEquals("", WordLogic.previousWord("end. "))
        assertEquals("thank", WordLogic.contextBeforeCurrent("thank yo"))
        assertEquals("", WordLogic.contextBeforeCurrent("yo"))
        assertEquals("", WordLogic.contextBeforeCurrent("end. yo"))
        assertEquals("בוקר", WordLogic.contextBeforeCurrent("בוקר ט"))
    }

    @Test fun revertAfterAutocorrect() {
        assertEquals(4 to "teh ", WordLogic.revertEdit("I said the ", "teh", "the", " "))
        assertEquals(null, WordLogic.revertEdit("I said the x", "teh", "the", " "))
        assertEquals(5 to "שלומ.", WordLogic.revertEdit("שלום.", "שלומ", "שלום", "."))
    }

    @Test fun arrangeWithAutocorrect() {
        assertEquals(listOf("teh", "the", "tea"), WordLogic.arrange("teh", listOf("the", "tea"), autocorrect = "the"))
        assertEquals(listOf("teh", "the", "tea"), WordLogic.arrange("teh", listOf("tea", "the"), autocorrect = "the"))
    }

    @Test fun wordsBack() {
        assertEquals(6, WordLogic.wordsBackLength("hello big world ", 1))
        assertEquals(10, WordLogic.wordsBackLength("hello big world ", 2))
        assertEquals(16, WordLogic.wordsBackLength("hello big world ", 5))
        assertEquals(5, WordLogic.wordsBackLength("hello", 1))
        assertEquals(5, WordLogic.wordsBackLength("I don't", 1))
        assertEquals(4, WordLogic.wordsBackLength("שלום עולם", 1))
        assertEquals(3, WordLogic.wordsBackLength("hi!!!", 1))
        assertEquals(0, WordLogic.wordsBackLength("", 1))
        assertEquals(0, WordLogic.wordsBackLength("abc", 0))
    }
}
