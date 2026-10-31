package com.talorys.keyboard.suggest

/** Pure text helpers for completions and gesture commits (unit-tested). */
object WordLogic {

    /**
     * The word immediately before the cursor ("" if none): letters, with inner apostrophes
     * (don't) and digits kept so "abc1" is seen as one token (and never autocorrected).
     */
    fun trailingWord(before: CharSequence?): String {
        if (before.isNullOrEmpty()) return ""
        var i = before.length
        while (i > 0) {
            val c = before[i - 1]
            if (Character.isLetterOrDigit(c)) { i--; continue }
            if ((c == '\'' || c == '\u2019') && i >= 2 && Character.isLetter(before[i - 2])) { i--; continue }
            break
        }
        // A token that is all digits is not a word.
        val w = before.subSequence(i, before.length).toString()
        return if (w.none { it.isLetter() }) "" else w
    }

    /** The word before the trailing spaces, i.e. the context for the next word ("" after punctuation or at the start). */
    fun previousWord(before: CharSequence?): String {
        if (before.isNullOrEmpty()) return ""
        var i = before.length
        while (i > 0 && before[i - 1] == ' ') i--
        if (i == 0 || !Character.isLetter(before[i - 1])) return ""
        return trailingWord(before.subSequence(0, i)).trimEnd('\'', '\u2019')
    }

    /** The word before the word being typed ("" at the start or after sentence punctuation). */
    fun contextBeforeCurrent(before: CharSequence?): String {
        if (before.isNullOrEmpty()) return ""
        val cur = trailingWord(before)
        return previousWord(before.subSequence(0, before.length - cur.length).let { s ->
            if (s.isNotEmpty() && s.last() == ' ') s else return ""
        })
    }

    fun hasDigit(w: String) = w.any { it.isDigit() }

    /**
     * Backspace right after an autocorrection: if the text before the cursor still ends with
     * [corrected] + [separator], returns how many chars to delete and what to put back.
     */
    fun revertEdit(before: CharSequence?, original: String, corrected: String, separator: String): Pair<Int, String>? {
        val tail = corrected + separator
        if (before == null || !before.endsWith(tail)) return null
        return tail.length to original + separator
    }

    /** Whether a swiped word typed after [prev] needs a separating space. */
    fun needsSpaceBefore(prev: Char?): Boolean {
        if (prev == null || prev.isWhitespace()) return false
        return prev !in "([{<\"“‘-/@#_\u05F3"
    }

    /** Applies the case the user typed (or the shift state) to a dictionary word. */
    fun matchCase(word: String, typed: String, english: Boolean, shiftOn: Boolean = false, capsLock: Boolean = false): String {
        if (!english) return word
        if (capsLock || (typed.length > 1 && typed.all { !it.isLetter() || it.isUpperCase() })) return word.uppercase()
        val cap = shiftOn || typed.firstOrNull()?.isUpperCase() == true || word == "i" || word.startsWith("i'")
        return if (cap) word.replaceFirstChar { it.uppercaseChar() } else word
    }

    /**
     * Places tap-typing candidates in the three strip slots (left, centre, right). The best
     * completion goes in the centre; the literal text the user typed stays reachable on the left
     * when it is not itself a suggestion.
     */
    fun arrange(typed: String, candidates: List<String>, autocorrect: String? = null): List<String?> {
        val c = (listOfNotNull(autocorrect) + candidates).distinct()
        if (c.isEmpty()) return listOf(null, typed.ifEmpty { null }, null)
        // The typed text always stays visible; with a pending autocorrection it sits left of it.
        if (autocorrect != null && !autocorrect.equals(typed, ignoreCase = true)) {
            return listOf(typed, autocorrect, c.firstOrNull { it != autocorrect && !it.equals(typed, ignoreCase = true) })
        }
        return if (typed.isNotEmpty() && c.none { it.equals(typed, ignoreCase = true) }) {
            listOf(typed, c.getOrNull(0), c.getOrNull(1))
        } else {
            listOf(c.getOrNull(1), c.getOrNull(0), c.getOrNull(2))
        }
    }

    /**
     * How many characters before the cursor cover the last [words] words (with the spaces and
     * punctuation after each), for backspace swipe / word-delete. "hello big world " with 1 →
     * "world " (6); a run of punctuation or spaces alone counts as one "word".
     */
    fun wordsBackLength(before: CharSequence?, words: Int): Int {
        if (before.isNullOrEmpty() || words <= 0) return 0
        var i = before.length
        repeat(words) {
            if (i == 0) return before.length
            // trailing spaces
            while (i > 0 && before[i - 1].isWhitespace()) i--
            if (i > 0 && isWordChar(before, i - 1)) {
                while (i > 0 && isWordChar(before, i - 1)) i--
            } else {
                // a run of symbols / punctuation
                while (i > 0 && !before[i - 1].isWhitespace() && !isWordChar(before, i - 1)) i--
            }
        }
        return before.length - i
    }

    private fun isWordChar(s: CharSequence, i: Int): Boolean {
        val c = s[i]
        if (Character.isLetterOrDigit(c)) return true
        // inner apostrophe (don't) / Hebrew geresh
        return (c == '\'' || c == '\u2019' || c == '\u05F3') && i > 0 && Character.isLetter(s[i - 1]) &&
            i + 1 < s.length && Character.isLetter(s[i + 1])
    }

    /** Separators that trigger autocorrect / learning of the word before them. */
    fun isWordSeparator(text: String): Boolean = text.length == 1 && text[0] in " .,!?;:\n)\"\u05BE"
}
