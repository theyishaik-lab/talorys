package com.talorys.keyboard.keyboard

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.AttributeSet
import android.util.SparseArray
import android.util.TypedValue
import android.view.MotionEvent
import android.view.View
import androidx.annotation.AttrRes
import androidx.annotation.DrawableRes
import androidx.appcompat.content.res.AppCompatResources
import androidx.core.graphics.ColorUtils
import androidx.core.util.size
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.customview.widget.ExploreByTouchHelper
import com.talorys.keyboard.R
import com.talorys.keyboard.suggest.Pt
import com.talorys.keyboard.suggest.SpatialModel
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

enum class ShiftState { OFF, ON, LOCKED }

/**
 * A lightweight, single-view keyboard in the Gboard style. Draws every key itself (no view per
 * key, nothing is re-laid-out while typing: a key press only invalidates), handles multi-touch so
 * two-thumb typing works, and supports:
 *
 * - **Dynamic hit boxes:** the touch area of every key covers the gaps around it, and a tap near
 *   the border of two letters goes to the one the language model expects ([nextCharProbs],
 *   [SpatialModel.pickKey]).
 * - **Long-press popups** with accents / symbols / digits (slide to choose, lift to type).
 * - **Space-bar cursor slide**, **backspace swipe-left** to select whole words for deletion, and
 *   an **accelerating backspace repeat** that switches to whole words after a while.
 * - **Glide typing**: a single finger that starts on a letter and travels draws a smooth fading
 *   trail and is reported as a path through [Listener.onGesture].
 * - **One-handed mode** ([oneHanded]): the board narrows to one side with a column of controls.
 *
 * Keys are exposed to TalkBack through an [ExploreByTouchHelper] (lift-to-type). Colours come
 * from the theme attributes kbBackground / kbKey / kbFunctionKey / kbKeyText / kbKeyHint /
 * kbAccentKey / kbAccentKeyText / kbTrail.
 */
class KeyboardView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    interface Listener {
        /** A key was tapped (or repeated, for delete). [touch] is where a letter was hit, in the decoder's key units. */
        fun onKey(key: Key, touch: Pt?)
        /** Long-press on a key without a popup. Return true if handled (suppresses the tap). */
        fun onLongPress(key: Key): Boolean
        /** Touch-down on any key, for haptic / sound feedback. */
        fun onKeyDown(key: Key)
        /** Text chosen from a long-press popup. */
        fun onText(text: String)
        /** A completed glide over the letters, in view coordinates. */
        fun onGesture(path: List<Pt>)
        /** Space-bar slide: move the cursor [steps] characters (positive = visually right). */
        fun onCursorMove(steps: Int)
        /**
         * Backspace swipe-left: select [words] words before the cursor (0 = none). [done] is true
         * when the finger lifts: delete the selection (or restore when 0).
         */
        fun onDeleteSwipe(words: Int, done: Boolean)
    }

    /** Shows / hides the key-press preview bubble and the long-press popup (rects in this view's coordinates). */
    interface PreviewListener {
        fun onPreview(label: String?, keyRect: RectF?)
        fun onPopup(options: List<String>?, rects: List<RectF>?, selected: Int)
    }

    var listener: Listener? = null
    var previewListener: PreviewListener? = null
    /** Show key-press preview bubbles. */
    var previewsEnabled = true

    /** Glide typing is offered only on letter boards and not in password fields. */
    var gestureEnabled: Boolean = false

    /** P(next letter) from the language model, for dynamic hit boxes (null = geometric only). */
    @Volatile var nextCharProbs: Map<Char, Float>? = null

    /** Draw corner hints on the left (RTL boards) instead of the right. */
    var hintsOnLeft: Boolean = false
        set(value) { if (field != value) { field = value; invalidate() } }

    private var rows: KeyRows = emptyList()

    private class Placed(val key: Key, val rect: RectF, val draw: RectF, val label: String, val upper: String)
    private val placed = ArrayList<Placed>()
    private val letterByChar = HashMap<Char, Placed>()

    var shiftState: ShiftState = ShiftState.OFF
        set(value) { if (field != value) { field = value; invalidate() } }

    /** Upper-case letter labels (English alpha mode with shift on). */
    var uppercaseLabels: Boolean = false
        set(value) { if (field != value) { field = value; invalidate() } }

    var spaceLabel: String = ""
        set(value) { if (field != value) { field = value; invalidate() } }
    var langLabel: String = ""
        set(value) { field = value }

    /** Show the small long-press hints in the key corners. */
    var showHints: Boolean = true
        set(value) { if (field != value) { field = value; invalidate() } }

    @DrawableRes private var enterIconRes: Int = R.drawable.tk_ic_enter
    private var enterDescription: String = context.getString(R.string.tk_key_enter)

    /** Height of one key row in px (user setting). Changing it re-measures once. */
    var rowHeight: Float = resources.getDimension(R.dimen.tk_kb_key_height)
        set(value) {
            if (abs(field - value) < 0.5f) return
            field = value
            updateSizes()
            requestLayout()
        }

    /** 0 = full width, -1 = one-handed on the left, +1 = on the right. */
    var oneHanded: Int = 0
        set(value) {
            if (field == value) return
            field = value
            cancelTouches()
            layoutKeys(width, height)
            invalidate()
            a11yHelper.invalidateRoot()
        }

    private val gapH = dp(3f)
    private var gapV = dp(4.5f)
    private val radius = resources.getDimension(R.dimen.tk_kb_key_radius)

    private var colorKey = 0
    private var colorFunction = 0
    private var colorText = 0
    private var colorHint = 0
    private var colorAccent = 0
    private var colorAccentText = 0
    private var colorTrail = 0
    private var colorPressedKey = 0
    private var colorPressedFunction = 0

    private val keyPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
    private val hintPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER }
    private val trailPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val trailPath = Path()
    private var textSizeLarge = 0f
    private var textSizeSmall = 0f
    private var textSizeEmoji = 0f
    private var iconSize = 0

    private val iconCache = HashMap<Int, Drawable>()

    // ---- touch tracking ----
    private enum class PMode { NORMAL, CURSOR, DELETE_SWIPE, POPUP }
    private class Pointer(var key: Key, val downX: Float, val downY: Float, var touch: Pt?) {
        var longPressed = false
        var mode = PMode.NORMAL
        var steps = 0
        var popup: List<String>? = null
        var popupRects: List<RectF>? = null
        var popupSel = 0
    }
    private val pointers = SparseArray<Pointer>()
    private val handler = Handler(Looper.getMainLooper())
    private var repeatKey: Key? = null
    private var repeatCount = 0
    private var longPressPointerId = -1

    // ---- gesture tracking ----
    private var gesturePointerId = -1
    private var gestureActive = false
    private var gestureStartX = 0f
    private var gestureStartY = 0f
    private val gesturePath = ArrayList<Pt>(256)
    private val gestureTimes = ArrayList<Long>(256)
    private val gestureThreshold get() = max(dp(24f), letterKeyWidth() * 0.55f)

    private val longPressRunnable = Runnable { onLongPressTimeout() }
    private val repeatRunnable = object : Runnable {
        override fun run() {
            val k = repeatKey ?: return
            repeatCount++
            if (repeatCount > WORD_DELETE_AFTER && k.code == Codes.DELETE) {
                listener?.onKey(Key(Codes.DELETE_WORD), null)
                handler.postDelayed(this, WORD_REPEAT_MS)
            } else {
                listener?.onKey(k, null)
                // Accelerates from 70 ms to 28 ms between repeats.
                handler.postDelayed(this, max(REPEAT_MIN_MS, REPEAT_START_INTERVAL_MS - repeatCount * 4L))
            }
        }
    }
    private val hidePreviewRunnable = Runnable { previewListener?.onPreview(null, null) }

    private val a11yHelper = KeyA11yHelper()

    init {
        ViewCompat.setAccessibilityDelegate(this, a11yHelper)
        isHapticFeedbackEnabled = true
        reloadColors()
        updateSizes()
    }

    /** Re-reads the theme colours (after a theme change). */
    fun reloadColors() {
        colorKey = themeColor(R.attr.kbKey)
        colorFunction = themeColor(R.attr.kbFunctionKey)
        colorText = themeColor(R.attr.kbKeyText)
        colorHint = themeColor(R.attr.kbKeyHint)
        colorAccent = themeColor(R.attr.kbAccentKey)
        colorAccentText = themeColor(R.attr.kbAccentKeyText)
        colorTrail = themeColor(R.attr.kbTrail)
        colorPressedKey = ColorUtils.blendARGB(colorKey, colorText, 0.16f)
        colorPressedFunction = ColorUtils.blendARGB(colorFunction, colorText, 0.16f)
        hintPaint.color = colorHint
        trailPaint.color = colorTrail
        invalidate()
    }

    private fun updateSizes() {
        val h = rowHeight
        gapV = (h * 0.085f).coerceIn(dp(3f), dp(6f))
        val keyH = h - 2 * gapV
        textSizeLarge = min(keyH * 0.52f, sp(26f))
        textSizeSmall = min(keyH * 0.34f, sp(17f))
        textSizeEmoji = keyH * 0.62f
        hintPaint.textSize = min(keyH * 0.24f, sp(12f))
        iconSize = min(keyH * 0.5f, dp(26f)).toInt()
    }

    fun setKeys(newRows: KeyRows) {
        cancelTouches()
        val sameShape = newRows.size == rows.size
        rows = newRows
        // All boards have the same height (BOARD_ROWS rows), so swapping boards never re-measures.
        if (!sameShape) requestLayout()
        layoutKeys(width, height)
        invalidate()
        a11yHelper.invalidateRoot()
    }

    fun setEnterAppearance(@DrawableRes icon: Int, description: String) {
        if (icon == enterIconRes && description == enterDescription) return
        enterIconRes = icon
        enterDescription = description
        invalidate()
    }

    /** Centres of the letter keys (lower-case label → centre), for the gesture decoder. */
    fun letterCenters(): Map<Char, Pt> =
        placed.filter { it.key.isLetter }.associate { p -> p.key.label[0] to Pt(p.rect.centerX(), p.rect.centerY()) }

    fun letterKeyWidth(): Float = placed.firstOrNull { it.key.isLetter }?.rect?.width() ?: dp(36f)
    fun letterKeyHeight(): Float = placed.firstOrNull { it.key.isLetter }?.rect?.height() ?: rowHeight

    // ---- measure / layout ----

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = (Layouts.BOARD_ROWS * rowHeight).toInt() + paddingTop + paddingBottom
        setMeasuredDimension(w, h)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        layoutKeys(w, h)
    }

    /** The key area (excluding padding and the one-handed control column). */
    private val board = RectF()
    private val sideColumn = RectF()

    private fun layoutKeys(totalWidth: Int, totalHeight: Int) {
        placed.clear()
        letterByChar.clear()
        if (totalWidth <= 0 || totalHeight <= 0) return
        val left = paddingLeft.toFloat()
        val top = paddingTop.toFloat()
        val w = (totalWidth - paddingLeft - paddingRight).toFloat()
        val h = (totalHeight - paddingTop - paddingBottom).toFloat()
        if (oneHanded == 0) {
            board.set(left, top, left + w, top + h)
            sideColumn.setEmpty()
        } else {
            val bw = w * ONE_HANDED_WIDTH
            if (oneHanded < 0) {
                board.set(left, top, left + bw, top + h); sideColumn.set(left + bw, top, left + w, top + h)
            } else {
                board.set(left + w - bw, top, left + w, top + h); sideColumn.set(left, top, left + w - bw, top + h)
            }
        }
        val boxes = Geometry.layout(rows, board.left, board.top, board.width(), board.height())
        for ((k, b) in boxes) addPlaced(k, RectF(b.left, b.top, b.right, b.bottom))
        if (oneHanded != 0) {
            val half = sideColumn.height() / 2f
            addPlaced(Key(Codes.ONE_HAND_SWITCH), RectF(sideColumn.left, sideColumn.top + half * 0.25f, sideColumn.right, sideColumn.top + half))
            addPlaced(Key(Codes.ONE_HAND_EXIT), RectF(sideColumn.left, sideColumn.top + half, sideColumn.right, sideColumn.top + half * 1.75f))
        }
    }

    private fun addPlaced(k: Key, r: RectF) {
        val d = RectF(r.left + gapH, r.top + gapV, r.right - gapH, r.bottom - gapV)
        val label = k.label
        val p = Placed(k, r, d, label, if (k.code == Codes.CHAR) label.uppercase() else label)
        placed += p
        if (k.isLetter) letterByChar[k.label[0]] = p
    }

    // ---- drawing ----

    override fun onDraw(canvas: Canvas) {
        val pressedAny = pointers.size > 0
        for (i in placed.indices) {
            val p = placed[i]
            val key = p.key
            if (key.style == KeyStyle.SPACER) continue
            val pressed = pressedAny && !gestureActive && isPressed(key)
            val r = p.draw
            if (key.code == Codes.ONE_HAND_SWITCH || key.code == Codes.ONE_HAND_EXIT) {
                if (pressed) { keyPaint.color = colorPressedFunction; canvas.drawRoundRect(r, radius, radius, keyPaint) }
                drawIcon(canvas, if (key.code == Codes.ONE_HAND_EXIT) R.drawable.tk_ic_fullscreen else R.drawable.tk_ic_swap_horiz, r, colorText)
                continue
            }
            if (key.style == KeyStyle.EMOJI) {
                if (pressed) {
                    keyPaint.color = ColorUtils.setAlphaComponent(colorText, 0x22)
                    canvas.drawRoundRect(r, radius, radius, keyPaint)
                }
                textPaint.textSize = textSizeEmoji
                textPaint.color = colorText
                textPaint.typeface = Typeface.DEFAULT
                canvas.drawText(p.label, r.centerX(), r.centerY() - (textPaint.descent() + textPaint.ascent()) / 2, textPaint)
                continue
            }
            val accent = key.style == KeyStyle.ACCENT || (key.code == Codes.SHIFT && shiftState == ShiftState.LOCKED)
            val function = key.style == KeyStyle.FUNCTION || (key.code == Codes.SHIFT && shiftState == ShiftState.ON)
            keyPaint.color = when {
                accent -> if (pressed) ColorUtils.blendARGB(colorAccent, colorAccentText, 0.2f) else colorAccent
                function -> if (pressed) colorPressedFunction else colorFunction
                else -> if (pressed) colorPressedKey else colorKey
            }
            val rr = if (key.round) r.height() / 2f else radius
            canvas.drawRoundRect(r, rr, rr, keyPaint)

            val fg = if (accent) colorAccentText else colorText
            val icon = iconFor(key)
            if (icon != 0) drawIcon(canvas, icon, r, fg) else drawLabel(canvas, p, r, fg)
        }
        if (gestureActive || trailFading()) drawTrail(canvas)
    }

    private fun drawLabel(canvas: Canvas, p: Placed, r: RectF, color: Int) {
        val key = p.key
        val label = when (key.code) {
            Codes.SPACE -> if (key.style == KeyStyle.SPACE) spaceLabel else "␣"
            Codes.CHAR -> if (uppercaseLabels) p.upper else p.label
            else -> p.label
        }
        if (label.isNotEmpty()) {
            textPaint.color = if (key.style == KeyStyle.SPACE) colorHint else color
            val isWord = label.length > 1 && label.codePointCount(0, label.length) > 1
            textPaint.textSize = if (isWord || key.style != KeyStyle.CHAR) textSizeSmall else textSizeLarge
            textPaint.typeface = if (key.style == KeyStyle.CHAR || key.style == KeyStyle.SPACE) Typeface.DEFAULT else Typeface.DEFAULT_BOLD
            val y = r.centerY() - (textPaint.descent() + textPaint.ascent()) / 2
            canvas.drawText(label, r.centerX(), y, textPaint)
        }
        if (showHints) key.hintLabel?.let { hint ->
            val x = if (hintsOnLeft) r.left + dp(6.5f) else r.right - dp(6.5f)
            canvas.drawText(hint, x, r.top - hintPaint.ascent() + dp(2f), hintPaint)
        }
    }

    private fun drawIcon(canvas: Canvas, @DrawableRes res: Int, r: RectF, color: Int) {
        val d = iconCache.getOrPut(res) { AppCompatResources.getDrawable(context, res)!!.mutate() }
        d.setTint(color)
        val size = iconSize
        val cx = r.centerX().toInt()
        val cy = r.centerY().toInt()
        d.setBounds(cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2)
        // Icons with autoMirrored follow the drawable's layout direction (LTR board).
        d.layoutDirection = LAYOUT_DIRECTION_LTR
        d.draw(canvas)
    }

    // ---- trail ----

    private var trailEndTime = 0L
    private fun trailFading(): Boolean = gestureTimes.isNotEmpty() && SystemClock.uptimeMillis() - trailEndTime < TRAIL_MS

    /**
     * The glide trail: a smooth curve (quadratic segments through the midpoints of the samples),
     * thick and opaque at the finger, thinning and fading along its recent past.
     */
    private fun drawTrail(canvas: Canvas) {
        val n = gesturePath.size
        if (n < 2) return
        val now = SystemClock.uptimeMillis()
        val maxW = dp(6.5f)
        var start = n - 1
        while (start > 0 && now - gestureTimes[start - 1] <= TRAIL_MS) start--
        start = max(1, start)
        for (i in start until n) {
            val age = now - gestureTimes[i]
            if (age > TRAIL_MS) continue
            val f = 1f - age / TRAIL_MS.toFloat()
            trailPaint.strokeWidth = max(dp(1.5f), maxW * f)
            trailPaint.alpha = (255 * min(1f, 0.2f + f)).toInt()
            val a = gesturePath[i - 1]; val b = gesturePath[i]
            val prev = if (i >= 2) gesturePath[i - 2] else a
            trailPath.reset()
            trailPath.moveTo((prev.x + a.x) / 2f, (prev.y + a.y) / 2f)
            trailPath.quadTo(a.x, a.y, (a.x + b.x) / 2f, (a.y + b.y) / 2f)
            canvas.drawPath(trailPath, trailPaint)
        }
        // Keep the tail fading while the finger rests or after it lifted.
        postInvalidateOnAnimation()
    }

    @DrawableRes
    private fun iconFor(key: Key): Int = when (key.code) {
        Codes.SHIFT -> when (shiftState) {
            ShiftState.OFF -> R.drawable.tk_ic_shift
            ShiftState.ON -> R.drawable.tk_ic_shift_on
            ShiftState.LOCKED -> R.drawable.tk_ic_caps_lock
        }
        Codes.DELETE -> R.drawable.tk_ic_backspace
        Codes.ENTER -> enterIconRes
        Codes.LANG -> R.drawable.tk_ic_language
        else -> 0
    }

    private fun labelFor(key: Key): String = when (key.code) {
        Codes.SPACE -> if (key.style == KeyStyle.SPACE) spaceLabel else "␣"
        Codes.CHAR -> if (uppercaseLabels) key.label.uppercase() else key.label
        else -> key.label
    }

    private fun describe(key: Key): String = when (key.code) {
        Codes.SHIFT -> context.getString(if (shiftState == ShiftState.LOCKED) R.string.tk_key_caps_lock else R.string.tk_key_shift)
        Codes.DELETE -> context.getString(R.string.tk_key_delete)
        Codes.ENTER -> enterDescription
        Codes.SPACE -> context.getString(R.string.tk_key_space)
        Codes.LANG -> context.getString(R.string.tk_key_language) + " (" + langLabel + ")"
        Codes.SYMBOLS, Codes.SYMBOLS_MORE -> context.getString(R.string.tk_key_symbols)
        Codes.ALPHA -> context.getString(R.string.tk_key_letters)
        Codes.EMOJI_PREV -> context.getString(R.string.tk_key_emoji_prev)
        Codes.EMOJI_NEXT -> context.getString(R.string.tk_key_emoji_next)
        Codes.ONE_HAND_SWITCH -> context.getString(R.string.tk_key_one_hand_switch)
        Codes.ONE_HAND_EXIT -> context.getString(R.string.tk_key_one_hand_exit)
        else -> labelFor(key)
    }

    // ---- preview / popup ----

    private fun placedOf(key: Key): Placed? = placed.firstOrNull { it.key === key }

    private fun showPreview(key: Key, label: String? = null) {
        if (key.code != Codes.CHAR || !previewsEnabled) return
        val p = placedOf(key) ?: return
        handler.removeCallbacks(hidePreviewRunnable)
        previewListener?.onPreview(label ?: labelFor(key), p.draw)
    }

    private fun hidePreview(delayMs: Long = 0) {
        handler.removeCallbacks(hidePreviewRunnable)
        if (delayMs > 0) handler.postDelayed(hidePreviewRunnable, delayMs) else hidePreviewRunnable.run()
    }

    /** Lays the popup cells out in a row above the key, clamped to the view. */
    private fun popupRects(key: Key, n: Int): List<RectF> {
        val p = placedOf(key) ?: return emptyList()
        val cellW = max(p.draw.width() * 0.95f, dp(34f))
        val cellH = p.draw.height()
        val total = cellW * n
        // The first (pre-selected) cell sits right above the key; the rest extend to the right,
        // shifted left as far as needed to stay on screen.
        var left = p.draw.centerX() - cellW / 2f
        if (left + total > width - dp(2f)) left = width - dp(2f) - total
        left = max(dp(2f), left)
        val bottom = p.draw.top - dp(4f)
        val top = bottom - cellH
        return List(n) { i -> RectF(left + i * cellW, top, left + (i + 1) * cellW, bottom) }
    }

    private fun popupIndexAt(p: Pointer, x: Float): Int {
        val rects = p.popupRects ?: return p.popupSel
        if (rects.isEmpty()) return 0
        if (x < rects.first().left) return 0
        if (x >= rects.last().right) return rects.size - 1
        return rects.indexOfFirst { x >= it.left && x < it.right }.coerceAtLeast(0)
    }

    // ---- touch ----

    /** The key whose (gap-covering) box contains the point, or the nearest one on that row. */
    private fun boxAt(x: Float, y: Float): Placed? {
        for (i in placed.indices) {
            val p = placed[i]
            if (p.key.style == KeyStyle.SPACER) continue
            if (p.rect.contains(x, y)) return p
        }
        // Touches in spacer gaps / edges / padding go to the nearest key.
        var best: Placed? = null
        var bestDist = Float.MAX_VALUE
        for (i in placed.indices) {
            val p = placed[i]
            if (p.key.style == KeyStyle.SPACER) continue
            val dx = if (x < p.rect.left) p.rect.left - x else if (x > p.rect.right) x - p.rect.right else 0f
            val dy = if (y < p.rect.top) p.rect.top - y else if (y > p.rect.bottom) y - p.rect.bottom else 0f
            val d = dx * dx * 0.25f + dy * dy // prefer the same row
            if (d < bestDist) { bestDist = d; best = p }
        }
        return best
    }

    /** [boxAt] refined by the spatial + language model for letter keys. */
    private fun keyAt(x: Float, y: Float): Placed? {
        val geo = boxAt(x, y) ?: return null
        val probs = nextCharProbs
        if (probs == null || !geo.key.isLetter || shiftState == ShiftState.LOCKED) return geo
        val kw = geo.rect.width()
        val dx = (x - geo.rect.centerX()) / (geo.rect.width() / 2f)
        val dy = (y - geo.rect.centerY()) / (geo.rect.height() / 2f)
        val core = max(abs(dx), abs(dy))
        if (core < SpatialModel.SAFE_CORE) return geo
        val cands = HashMap<Char, Pt>()
        for ((c, p) in letterByChar) {
            if (abs(p.rect.centerX() - x) <= kw * 1.6f && abs(p.rect.centerY() - y) <= p.rect.height() * 1.6f) {
                cands[c] = Pt(p.rect.centerX() / kw, p.rect.centerY() / kw)
            }
        }
        val picked = SpatialModel.pickKey(geo.key.label[0], Pt(x / kw, y / kw), core, cands, probs)
        return letterByChar[picked] ?: geo
    }

    /** A touch point in the decoder's nominal key units (board scaled to 1080 × 750, key = 108). */
    private fun nominalTouch(x: Float, y: Float): Pt? {
        if (board.width() <= 0f || board.height() <= 0f) return null
        val nx = (x - board.left) / board.width() * NOMINAL_W
        val ny = (y - board.top) / board.height() * NOMINAL_H
        return Pt(nx / NOMINAL_KEY, ny / NOMINAL_KEY)
    }

    private fun isPressed(key: Key): Boolean {
        for (i in 0 until pointers.size) if (pointers.valueAt(i).key === key) return true
        return false
    }

    // Keys are activated through onTouchEvent (sighted users) and the ExploreByTouchHelper (TalkBack).
    override fun performClick(): Boolean = super.performClick()

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_POINTER_DOWN -> {
                if (gestureActive) return true // a second finger during a glide is ignored
                val idx = event.actionIndex
                val x = event.getX(idx); val y = event.getY(idx)
                val hit = keyAt(x, y) ?: return true
                val key = hit.key
                // A new finger down commits any other in-flight character first, so fast
                // two-thumb typing keeps the order the keys were touched in.
                for (i in pointers.size - 1 downTo 0) {
                    val other = pointers.valueAt(i)
                    if (!other.key.repeatable && !other.longPressed && other.mode == PMode.NORMAL && other.key.code == Codes.CHAR) {
                        val otherId = pointers.keyAt(i)
                        pointers.removeAt(i)
                        onPointerUp(otherId, other)
                    }
                }
                val id = event.getPointerId(idx)
                val ptr = Pointer(key, x, y, if (key.isLetter) nominalTouch(x, y) else null)
                pointers.put(id, ptr)
                // Only a lone finger that lands on a letter can start a glide.
                if (gestureEnabled && pointers.size == 1 && key.isLetter) {
                    gesturePointerId = id
                    gestureStartX = x; gestureStartY = y
                    gesturePath.clear(); gestureTimes.clear()
                    addGesturePoint(x, y)
                } else {
                    gesturePointerId = -1
                }
                onPointerDown(id, ptr)
            }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until event.pointerCount) {
                    val id = event.getPointerId(i)
                    val p = pointers.get(id) ?: continue
                    val x = event.getX(i); val y = event.getY(i)
                    if (id == gesturePointerId && p.mode == PMode.NORMAL) {
                        for (h in 0 until event.historySize) addGesturePoint(event.getHistoricalX(i, h), event.getHistoricalY(i, h))
                        addGesturePoint(x, y)
                        if (!gestureActive && !p.longPressed &&
                            hypot(x - gestureStartX, y - gestureStartY) > gestureThreshold) {
                            startGesture()
                        }
                        if (gestureActive) { invalidate(); continue }
                    }
                    onPointerMove(id, p, x, y)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_POINTER_UP -> {
                val id = event.getPointerId(event.actionIndex)
                val p = pointers.get(id)
                pointers.remove(id)
                if (id == gesturePointerId && gestureActive) {
                    addGesturePoint(event.getX(event.actionIndex), event.getY(event.actionIndex))
                    finishGesture()
                } else if (p != null) {
                    onPointerUp(id, p)
                }
                if (id == gesturePointerId) gesturePointerId = -1
                invalidate()
            }
            MotionEvent.ACTION_CANCEL -> cancelTouches()
        }
        return true
    }

    private fun onPointerMove(id: Int, p: Pointer, x: Float, y: Float) {
        val kw = letterKeyWidth()
        when (p.mode) {
            PMode.POPUP -> {
                val sel = popupIndexAt(p, x)
                if (sel != p.popupSel) {
                    p.popupSel = sel
                    previewListener?.onPopup(p.popup, p.popupRects, sel)
                }
                return
            }
            PMode.CURSOR -> {
                val steps = ((x - p.downX) / (kw * CURSOR_STEP)).toInt()
                if (steps != p.steps) {
                    listener?.onCursorMove(steps - p.steps)
                    p.steps = steps
                }
                return
            }
            PMode.DELETE_SWIPE -> {
                val dist = p.downX - x
                // Back toward the key (less than a third of a key away) cancels.
                val words = if (dist < kw * 0.3f) 0 else 1 + ((dist - kw * DELETE_SWIPE_START).coerceAtLeast(0f) / (kw * DELETE_WORD_STEP)).toInt()
                if (words != p.steps) {
                    p.steps = words
                    listener?.onDeleteSwipe(words, false)
                }
                return
            }
            PMode.NORMAL -> Unit
        }
        if (p.longPressed) return
        val dx = x - p.downX
        // Space: horizontal slide moves the cursor.
        if (p.key.code == Codes.SPACE && abs(dx) > kw * CURSOR_START) {
            p.mode = PMode.CURSOR
            p.steps = 0
            cancelLongPress(id)
            onPointerMove(id, p, x, y)
            return
        }
        // Backspace: a slide to the left selects whole words to delete.
        if (p.key.code == Codes.DELETE && -dx > kw * DELETE_SWIPE_START) {
            p.mode = PMode.DELETE_SWIPE
            p.steps = 0
            stopRepeat()
            onPointerMove(id, p, x, y)
            return
        }
        if (p.key.repeatable || p.key.code == Codes.SPACE) return
        val k = keyAt(x, y)?.key ?: return
        if (k !== p.key) {
            p.key = k
            p.touch = if (k.isLetter) nominalTouch(x, y) else null
            if (id == longPressPointerId) scheduleLongPress(id, k)
            if (k.code == Codes.CHAR) showPreview(k) else hidePreview()
            invalidate()
        }
    }

    private fun addGesturePoint(x: Float, y: Float) {
        // Drop samples closer than a pixel or two: keeps the path (and the decoder input) lean.
        val last = gesturePath.lastOrNull()
        if (last != null && abs(last.x - x) + abs(last.y - y) < dp(1.5f)) return
        gesturePath += Pt(x, y)
        gestureTimes += SystemClock.uptimeMillis()
    }

    private fun startGesture() {
        gestureActive = true
        handler.removeCallbacks(longPressRunnable)
        longPressPointerId = -1
        hidePreview()
        invalidate()
    }

    private fun finishGesture() {
        val path = ArrayList(gesturePath)
        gestureActive = false
        trailEndTime = SystemClock.uptimeMillis()
        pointers.clear()
        listener?.onGesture(path)
        postInvalidateOnAnimation()
    }

    private fun onPointerDown(id: Int, p: Pointer) {
        val key = p.key
        listener?.onKeyDown(key)
        if (key.repeatable) {
            stopRepeat()
            repeatKey = key
            repeatCount = 0
            listener?.onKey(key, null)
            handler.postDelayed(repeatRunnable, REPEAT_START_MS)
        } else {
            scheduleLongPress(id, key)
            if (key.code == Codes.CHAR) showPreview(key) else hidePreview()
        }
        invalidate()
    }

    private fun scheduleLongPress(id: Int, key: Key) {
        handler.removeCallbacks(longPressRunnable)
        longPressPointerId = id
        if ((key.popup?.size ?: 0) > 1 || key.longPress != null || key.longPressCode != null ||
            key.code == Codes.LANG || key.code == Codes.SPACE) {
            handler.postDelayed(longPressRunnable, LONG_PRESS_MS)
        }
    }

    private fun cancelLongPress(id: Int) {
        if (id == longPressPointerId) {
            handler.removeCallbacks(longPressRunnable)
            longPressPointerId = -1
        }
    }

    private fun onLongPressTimeout() {
        val p = pointers.get(longPressPointerId) ?: return
        if (gestureActive || p.mode != PMode.NORMAL) return
        val popup = p.key.popup
        if (popup != null && popup.size > 1) {
            val options = if (uppercaseLabels) popup.map { o -> o.uppercase().takeIf { it.length == o.length } ?: o } else popup
            p.mode = PMode.POPUP
            p.longPressed = true
            p.popup = options
            p.popupRects = popupRects(p.key, options.size)
            p.popupSel = 0
            hidePreview()
            previewListener?.onPopup(options, p.popupRects, 0)
            listener?.onKeyDown(p.key) // a tick when the popup opens
            invalidate()
            return
        }
        if (listener?.onLongPress(p.key) == true) {
            p.longPressed = true
            val hint = p.key.longPress
            if (hint != null) showPreview(p.key, hint) else hidePreview()
            invalidate()
        }
    }

    private fun onPointerUp(id: Int, p: Pointer) {
        cancelLongPress(id)
        when (p.mode) {
            PMode.POPUP -> {
                previewListener?.onPopup(null, null, -1)
                p.popup?.getOrNull(p.popupSel)?.let { listener?.onText(it) }
                return
            }
            PMode.CURSOR -> return
            PMode.DELETE_SWIPE -> { listener?.onDeleteSwipe(p.steps, true); return }
            PMode.NORMAL -> Unit
        }
        hidePreview(if (p.longPressed) 250 else PREVIEW_LINGER_MS)
        if (p.key.repeatable) {
            stopRepeat()
            return
        }
        if (!p.longPressed) listener?.onKey(p.key, p.touch)
    }

    private fun stopRepeat() {
        handler.removeCallbacks(repeatRunnable)
        repeatKey = null
        repeatCount = 0
    }

    fun cancelTouches() {
        handler.removeCallbacks(longPressRunnable)
        stopRepeat()
        // An in-progress delete swipe is cancelled (selection restored).
        for (i in 0 until pointers.size) if (pointers.valueAt(i).mode == PMode.DELETE_SWIPE) listener?.onDeleteSwipe(0, true)
        pointers.clear()
        longPressPointerId = -1
        gestureActive = false
        gesturePointerId = -1
        gesturePath.clear(); gestureTimes.clear()
        hidePreview()
        previewListener?.onPopup(null, null, -1)
        invalidate()
    }

    override fun onDetachedFromWindow() {
        cancelTouches()
        super.onDetachedFromWindow()
    }

    override fun dispatchHoverEvent(event: MotionEvent): Boolean =
        a11yHelper.dispatchHoverEvent(event) || super.dispatchHoverEvent(event)

    // ---- helpers ----

    private fun themeColor(@AttrRes attr: Int): Int {
        val tv = TypedValue()
        context.theme.resolveAttribute(attr, tv, true)
        return if (tv.resourceId != 0) context.getColor(tv.resourceId) else tv.data
    }

    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun sp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v, resources.displayMetrics)

    /** TalkBack support: each key is a virtual view; double-tap / lift activates it. */
    private inner class KeyA11yHelper : ExploreByTouchHelper(this@KeyboardView) {
        override fun getVirtualViewAt(x: Float, y: Float): Int {
            val k = boxAt(x, y) ?: return HOST_ID
            return placed.indexOf(k).takeIf { it >= 0 } ?: HOST_ID
        }

        override fun getVisibleVirtualViews(virtualViewIds: MutableList<Int>) {
            placed.forEachIndexed { i, p -> if (p.key.style != KeyStyle.SPACER) virtualViewIds += i }
        }

        @Suppress("DEPRECATION") // ExploreByTouchHelper still requires bounds-in-parent
        override fun onPopulateNodeForVirtualView(virtualViewId: Int, node: AccessibilityNodeInfoCompat) {
            val p = placed.getOrNull(virtualViewId) ?: run {
                node.contentDescription = ""
                node.setBoundsInParent(android.graphics.Rect(0, 0, 1, 1))
                return
            }
            node.contentDescription = describe(p.key)
            node.className = "android.inputmethodservice.Keyboard\$Key"
            node.addAction(AccessibilityNodeInfoCompat.ACTION_CLICK)
            val r = android.graphics.Rect()
            p.rect.roundOut(r)
            node.setBoundsInParent(r)
        }

        override fun onPerformActionForVirtualView(virtualViewId: Int, action: Int, arguments: Bundle?): Boolean {
            if (action != AccessibilityNodeInfoCompat.ACTION_CLICK) return false
            val key = placed.getOrNull(virtualViewId)?.key ?: return false
            listener?.onKeyDown(key)
            listener?.onKey(key, null)
            return true
        }
    }

    companion object {
        const val LONG_PRESS_MS = 350L
        const val REPEAT_START_MS = 380L
        const val REPEAT_START_INTERVAL_MS = 70L
        const val REPEAT_MIN_MS = 28L
        /** After this many repeated characters, backspace deletes whole words. */
        const val WORD_DELETE_AFTER = 28
        const val WORD_REPEAT_MS = 140L
        const val PREVIEW_LINGER_MS = 60L
        const val TRAIL_MS = 220L
        /** Space slide: start after this many key widths, one cursor step per [CURSOR_STEP]. */
        const val CURSOR_START = 0.6f
        const val CURSOR_STEP = 0.4f
        /** Backspace swipe: start after this many key widths; one word per [DELETE_WORD_STEP]. */
        const val DELETE_SWIPE_START = 0.8f
        const val DELETE_WORD_STEP = 0.75f
        const val ONE_HANDED_WIDTH = 0.84f
        /** Nominal board the word engine's key geometry is built on (see TalorysInputMethodService.proximity). */
        const val NOMINAL_W = 1080f
        const val NOMINAL_H = 750f
        const val NOMINAL_KEY = 108f
    }
}
