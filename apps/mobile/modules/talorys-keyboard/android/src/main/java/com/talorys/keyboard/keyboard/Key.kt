package com.talorys.keyboard.keyboard

/** Special key codes. Character keys use [Codes.CHAR] and carry their text. */
object Codes {
    const val CHAR = 0
    const val SHIFT = -1
    const val DELETE = -2
    const val ENTER = -3
    const val SPACE = -4
    const val LANG = -5
    const val SYMBOLS = -6
    const val SYMBOLS_MORE = -7
    const val ALPHA = -8
    const val EMOJI = -9
    const val EMOJI_PREV = -10
    const val EMOJI_NEXT = -11
    /** Delete the word before the cursor (accelerated backspace repeat). */
    const val DELETE_WORD = -12
    /** One-handed mode side buttons. */
    const val ONE_HAND_SWITCH = -13
    const val ONE_HAND_EXIT = -14
    const val SPACER = -100
}

/** CHAR = letter/symbol key, EMOJI = emoji cell (drawn without a key cap). */
enum class KeyStyle { CHAR, FUNCTION, ACCENT, SPACE, SPACER, EMOJI }

/**
 * One key on the board.
 * @param width relative width; each row sums to 10 units.
 * @param longPress text committed on long-press; also drawn as the small corner hint.
 * @param hint corner hint to draw instead of [longPress] (e.g. an emoji face on the comma key).
 * @param longPressCode special action on long-press (e.g. [Codes.EMOJI] on the comma key).
 * @param round draw as a pill / circle (the ?123 and Enter keys).
 * @param popup long-press choices (accents, symbols, digits) shown as a mini keyboard; the first
 *   one is pre-selected. Null or a single entry falls back to [longPress].
 */
data class Key(
    val code: Int,
    val label: String = "",
    val text: String? = null,
    val width: Float = 1f,
    val style: KeyStyle = if (code == Codes.CHAR) KeyStyle.CHAR else KeyStyle.FUNCTION,
    val longPress: String? = null,
    val repeatable: Boolean = false,
    val hint: String? = null,
    val longPressCode: Int? = null,
    val round: Boolean = false,
    val popup: List<String>? = null,
) {
    val output: String get() = text ?: label
    val hintLabel: String? get() = hint ?: longPress

    /** True for single-letter keys that can take part in gesture typing. */
    val isLetter: Boolean
        get() = code == Codes.CHAR && style == KeyStyle.CHAR && label.length == 1 && Character.isLetter(label[0])

    companion object {
        fun char(c: String, longPress: String? = null, width: Float = 1f, popup: List<String>? = null) =
            Key(Codes.CHAR, label = c, longPress = longPress, width = width, popup = popup)

        fun emoji(e: String, width: Float) = Key(Codes.CHAR, label = e, width = width, style = KeyStyle.EMOJI)

        fun spacer(width: Float) = Key(Codes.SPACER, width = width, style = KeyStyle.SPACER)
    }
}

typealias KeyRows = List<List<Key>>

/** Plain rectangle (no android.graphics dependency, so geometry is unit-testable). */
data class Box(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width get() = right - left
    val height get() = bottom - top
    val centerX get() = (left + right) / 2f
    val centerY get() = (top + bottom) / 2f
    fun contains(x: Float, y: Float) = x >= left && x < right && y >= top && y < bottom
}

object Geometry {
    /** Lays rows out edge to edge: each row is scaled to the full width, rows share the height equally. */
    fun layout(rows: KeyRows, left: Float, top: Float, width: Float, height: Float): List<Pair<Key, Box>> {
        if (rows.isEmpty() || width <= 0f || height <= 0f) return emptyList()
        val rowH = height / rows.size
        val out = ArrayList<Pair<Key, Box>>()
        rows.forEachIndexed { r, row ->
            val units = row.sumOf { it.width.toDouble() }.toFloat().coerceAtLeast(1f)
            val unitW = width / units
            var x = left
            val t = top + r * rowH
            for (key in row) {
                val w = key.width * unitW
                out += key to Box(x, t, x + w, t + rowH)
                x += w
            }
        }
        return out
    }
}
