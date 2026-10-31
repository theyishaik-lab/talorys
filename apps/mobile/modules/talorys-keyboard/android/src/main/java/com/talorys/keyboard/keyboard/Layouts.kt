package com.talorys.keyboard.keyboard

enum class Language(val tag: String) { EN("en"), HE("he");
    companion object { fun fromTag(tag: String?) = entries.firstOrNull { tag?.startsWith(it.tag) == true || (it == HE && tag?.startsWith("iw") == true) } ?: EN }
}

enum class Mode { ALPHA, SYMBOLS, SYMBOLS_MORE, NUMBER, PHONE, EMOJI }

/** Which punctuation key sits next to the space bar, depending on the field type. */
enum class FieldFlavor { TEXT, EMAIL, URI }

/**
 * Static keyboard layouts (Gboard-style). Rows are laid out left-to-right regardless of locale
 * (physical layout). Every letter board has a number row on top and long-press hints on letters.
 */
object Layouts {

    /** All boards are drawn at the height of this many rows; boards with fewer rows get taller keys. */
    const val BOARD_ROWS = 5

    private fun chars(s: String, longPress: String? = null, width: Float = 1f, digits: Boolean = false): List<Key> {
        val hints = longPress?.split(' ')
        return s.split(' ').mapIndexed { i, c ->
            val hint = hints?.getOrNull(i)
            val digit = if (digits && i < 10) ((i + 1) % 10).toString() else null
            val popup = (listOfNotNull(hint, digit) + ACCENTS[c].orEmpty()).distinct()
            Key.char(c, hint, width, popup.takeIf { it.size > 1 })
        }
    }

    /** Long-press accents for Latin letters (Gboard order: most common first). */
    val ACCENTS: Map<String, List<String>> = mapOf(
        "a" to "à á â ä æ ã å ā".split(' '),
        "c" to "ç ć č".split(' '),
        "d" to listOf("ð"),
        "e" to "è é ê ë ē ę ė".split(' '),
        "g" to listOf("ğ"),
        "i" to "ì í î ï ī į".split(' '),
        "l" to listOf("ł"),
        "n" to "ñ ń".split(' '),
        "o" to "ò ó ô ö õ ø œ ō".split(' '),
        "s" to "ß ś š".split(' '),
        "u" to "ù ú û ü ū".split(' '),
        "y" to "ý ÿ".split(' '),
        "z" to "ž ź ż".split(' '),
        // Hebrew: the geresh / gershayim and maqaf variants on the punctuation keys.
        "'" to listOf("׳", "״", "\""),
        "-" to listOf("־", "–", "—", "_"),
    )

    /** Punctuation offered by long-pressing the period key. */
    val PERIOD_POPUP = listOf("…", "?", "!", ",", "'", "\"", ":", ";", "-", "@", "#", "/")

    private val numberRow get() = chars("1 2 3 4 5 6 7 8 9 0")

    private fun bottomRow(modeKeyLabel: String, modeKeyCode: Int, flavor: FieldFlavor, showLang: Boolean): List<Key> {
        val leftPunct = when (flavor) {
            FieldFlavor.EMAIL -> Key.char("@")
            FieldFlavor.URI -> Key.char("/")
            FieldFlavor.TEXT -> Key(Codes.CHAR, label = ",", hint = "☺", longPressCode = Codes.EMOJI)
        }
        val row = mutableListOf(Key(modeKeyCode, label = modeKeyLabel, width = 1.5f, round = true))
        row += leftPunct
        if (showLang) row += Key(Codes.LANG, width = 1f)
        row += Key(Codes.SPACE, width = if (showLang) 4f else 5f, style = KeyStyle.SPACE)
        row += Key.char(".", popup = if (flavor == FieldFlavor.TEXT) PERIOD_POPUP else null)
        row += Key(Codes.ENTER, width = 1.5f, style = KeyStyle.ACCENT, round = true)
        return row
    }

    fun build(mode: Mode, lang: Language, flavor: FieldFlavor, abcLabel: String, showLang: Boolean, emojiPage: Int = 0): KeyRows = when (mode) {
        Mode.ALPHA -> if (lang == Language.HE) hebrew(flavor, showLang) else english(flavor, showLang)
        Mode.SYMBOLS -> symbols(abcLabel, flavor, showLang)
        Mode.SYMBOLS_MORE -> symbolsMore(abcLabel, flavor, showLang)
        Mode.NUMBER -> number()
        Mode.PHONE -> phone()
        Mode.EMOJI -> emoji(abcLabel, emojiPage)
    }

    val englishHints = listOf("% \\ | = [ ] < > { }", "@ # $ _ & - + ( )", "* \" ' : ; ! ?")

    fun english(flavor: FieldFlavor, showLang: Boolean): KeyRows = listOf(
        numberRow,
        chars("q w e r t y u i o p", englishHints[0], digits = true),
        listOf(Key.spacer(0.5f)) + chars("a s d f g h j k l", englishHints[1]) + Key.spacer(0.5f),
        listOf(Key(Codes.SHIFT, width = 1.5f)) + chars("z x c v b n m", englishHints[2]) +
            Key(Codes.DELETE, width = 1.5f, repeatable = true),
        bottomRow("?123", Codes.SYMBOLS, flavor, showLang),
    )

    val hebrewHints = listOf("% \\ | = [ ] < > { }", "@ # ₪ _ & - + ( ) /", "` * \" ' : ; ! ? \\")

    /** Israeli (SI-1452) letter arrangement as on Gboard, with the ' and - keys leading the top row. */
    fun hebrew(flavor: FieldFlavor, showLang: Boolean): KeyRows = listOf(
        numberRow,
        chars("' - ק ר א ט ו ן ם פ", hebrewHints[0], digits = true),
        chars("ש ד ג כ ע י ח ל ך ף", hebrewHints[1]),
        chars("ז ס ב ה נ מ צ ת ץ", hebrewHints[2]) + Key(Codes.DELETE, width = 1f, repeatable = true),
        bottomRow("?123", Codes.SYMBOLS, flavor, showLang),
    )

    private fun symbols(abc: String, flavor: FieldFlavor, showLang: Boolean): KeyRows = listOf(
        chars("1 2 3 4 5 6 7 8 9 0"),
        chars("@ # ₪ _ & - + ( ) /"),
        listOf(Key(Codes.SYMBOLS_MORE, label = "=\\<", width = 1.5f)) + chars("* \" ' : ; ! ?") +
            Key(Codes.DELETE, width = 1.5f, repeatable = true),
        bottomRow(abc, Codes.ALPHA, flavor, showLang),
    )

    private fun symbolsMore(abc: String, flavor: FieldFlavor, showLang: Boolean): KeyRows = listOf(
        chars("~ ` | • √ π ÷ × ¶ ∆"),
        chars("€ \$ £ ¥ ^ ° = { } \\"),
        listOf(Key(Codes.SYMBOLS_MORE, label = "?123", width = 1.5f)) + chars("% © ® ™ ✓ [ ]") +
            Key(Codes.DELETE, width = 1.5f, repeatable = true),
        bottomRow(abc, Codes.ALPHA, flavor, showLang),
    )

    private fun number(): KeyRows = listOf(
        chars("1 2 3") + Key.char("-", width = 1f),
        chars("4 5 6") + Key(Codes.SPACE, width = 1f, style = KeyStyle.FUNCTION),
        chars("7 8 9") + Key(Codes.DELETE, width = 1f, repeatable = true),
        listOf(Key.char(","), Key.char("0"), Key.char("."), Key(Codes.ENTER, width = 1f, style = KeyStyle.ACCENT, round = true)),
    )

    private fun phone(): KeyRows = listOf(
        chars("1 2 3") + Key.char("-", width = 1f),
        chars("4 5 6") + Key.char("+", width = 1f),
        chars("7 8 9") + Key(Codes.DELETE, width = 1f, repeatable = true),
        listOf(Key.char("*"), Key.char("0"), Key.char("#"), Key(Codes.ENTER, width = 1f, style = KeyStyle.ACCENT, round = true)),
    )

    // ---- emoji ----

    private const val EMOJI_COLS = 8
    private const val EMOJI_ROWS = 4

    private val EMOJI = (
        "😀 😃 😄 😁 😆 😅 😂 🤣 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 " +
        "😶 😏 😒 🙄 😬 😌 😔 😪 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 " +
        "😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 💀 💩 🤡 👻 👽 🤖 😺 😸 😹 😻 😼 😽 " +
        "👍 👎 👌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 👏 🙌 👐 🤲 💪 ✍️ 💅 🤳 👀 👁️ 🧠 👄 " +
        "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🕳️ 💬 💭 💤 ✨ 🔥 ⭐ 🌟 " +
        "🎉 🎊 🎈 🎁 🎂 🍰 🍕 🍔 🍟 🌭 🥗 🍣 🍜 🍩 🍪 🍫 ☕ 🍵 🍺 🍷 🥂 🍾 ⚽ 🏀 🎵 🎶 📷 💻 📱 ⏰ 🚗 ✈️ " +
        "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🌸 🌹 🌻 🌷 🌈 ☀️ 🌙 ⛅ ☔ ❄️ 🌊 🇮🇱 ✅ ❌ ❓ ❗"
        ).split(' ')

    val emojiPageCount: Int get() = (EMOJI.size + EMOJI_COLS * EMOJI_ROWS - 1) / (EMOJI_COLS * EMOJI_ROWS)

    private fun emoji(abc: String, page: Int): KeyRows {
        val per = EMOJI_COLS * EMOJI_ROWS
        val p = page.mod(emojiPageCount)
        val slice = EMOJI.drop(p * per).take(per)
        val cellW = 10f / EMOJI_COLS
        val rows = (0 until EMOJI_ROWS).map { r ->
            (0 until EMOJI_COLS).map { c -> slice.getOrNull(r * EMOJI_COLS + c)?.let { Key.emoji(it, cellW) } ?: Key.spacer(cellW) }
        }
        return rows + listOf(listOf(
            Key(Codes.ALPHA, label = abc, width = 1.5f, round = true),
            Key(Codes.EMOJI_PREV, label = "‹", width = 1.25f),
            Key(Codes.SPACE, width = 4f, style = KeyStyle.SPACE),
            Key(Codes.EMOJI_NEXT, label = "›", width = 1.25f),
            Key(Codes.DELETE, width = 2f, repeatable = true),
        ))
    }
}
