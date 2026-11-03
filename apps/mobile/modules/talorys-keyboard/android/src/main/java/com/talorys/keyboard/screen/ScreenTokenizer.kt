package com.talorys.keyboard.screen

/** One word read from the screen: its language ("he" / "en") and its normalized form. */
data class ScreenToken(val lang: String, val word: String)

/**
 * Turns text read from the screen into candidate words for the personal dictionary.
 * Pure Kotlin (unit-tested); no Android types.
 *
 * - URLs, e-mail addresses, @handles and #tags are removed before splitting.
 * - A token is a run of Hebrew letters or of Latin letters (with an inner apostrophe in English).
 *   Tokens with digits, mixed scripts, or other symbols are dropped, never split into pieces.
 * - Hebrew niqqud / cantillation marks are stripped; English is lower-cased.
 * - Too short (< [MIN_LEN]) or too long (> [MAX_LEN]) tokens, and letter repeats like "aaaa", are dropped.
 * - Upper-case-only English tokens (acronyms like "HTTP", "OK") are dropped.
 */
object ScreenTokenizer {
    const val MIN_LEN = 3
    const val MAX_LEN = 24

    private val URL = Regex("""(?i)\b(?:https?://|ftp://|www\.)\S+|\b[\w.-]+\.(?:com|net|org|io|il|co|dev|app|ai|me|gov|edu)(?:/\S*)?\b""")
    private val EMAIL = Regex("""[\w.+-]+@[\w-]+(?:\.[\w-]+)+""")
    private val HANDLE = Regex("""[@#]\w+""")
    private val NIQQUD = Regex("[\u0591-\u05C7]")
    /** Anything that is not a letter, apostrophe or Hebrew geresh/gershayim separates tokens. */
    private val SPLIT = Regex("""[^\p{L}\p{M}'’\u05F3\u05F4"0-9]+""")
    private val REPEAT = Regex("""(.)\1\1""")

    fun isHebrewLetter(c: Char) = c in '\u05D0'..'\u05EA'
    private fun isLatin(c: Char) = c in 'a'..'z' || c in 'A'..'Z'

    /** All acceptable tokens of [text], in order, duplicates kept. */
    fun tokenize(text: CharSequence): List<ScreenToken> {
        if (text.isEmpty()) return emptyList()
        var s = text.toString()
        s = EMAIL.replace(s, " ")
        s = URL.replace(s, " ")
        s = HANDLE.replace(s, " ")
        s = NIQQUD.replace(s, "")
        val out = ArrayList<ScreenToken>()
        for (raw in SPLIT.split(s)) {
            val t = raw.trim('\'', '’', '"', '\u05F3', '\u05F4')
            classify(t)?.let { out += it }
        }
        return out
    }

    /** The token for one already-split piece, or null when it isn't a word worth learning. */
    fun classify(piece: String): ScreenToken? {
        if (piece.length < MIN_LEN || piece.length > MAX_LEN) return null
        if (piece.any { it.isDigit() }) return null
        if (REPEAT.containsMatchIn(piece.lowercase())) return null
        return when {
            piece.all { isHebrewLetter(it) } -> ScreenToken("he", piece)
            piece.all { isLatin(it) || it == '\'' || it == '’' } -> {
                if (!isLatin(piece.first()) || !isLatin(piece.last())) return null
                if (piece.count { it == '\'' || it == '’' } > 1) return null
                // Acronyms and shouting ("HTTP", "SALE") are not words to suggest.
                if (piece.all { !it.isLetter() || it.isUpperCase() }) return null
                ScreenToken("en", piece.replace('’', '\'').lowercase())
            }
            else -> null
        }
    }
}
