package com.talorys.keyboard.keyboard

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.TextPaint
import android.text.TextUtils
import android.util.AttributeSet
import android.util.TypedValue
import android.view.MotionEvent
import android.view.View
import androidx.annotation.AttrRes
import androidx.annotation.DrawableRes
import androidx.appcompat.content.res.AppCompatResources
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.customview.widget.ExploreByTouchHelper
import com.talorys.keyboard.R

/**
 * The row above the keys, drawn as one view (updating it never re-lays-out the keyboard: a
 * new suggestion only invalidates, unlike TextViews whose setText requests a layout).
 *
 * Two faces, like Gboard:
 * - **Toolbar** (nothing being typed): clipboard, emoji, Ask Talorys, one-handed, settings and
 *   the Talorys panel, plus the mic on the end.
 * - **Suggestions** (while typing): three slots with the best in the middle (bold when it will
 *   autocorrect), thin dividers, a chevron on the start side that opens the toolbar, mic on the end.
 *   A slot can be a "chip" (rounded, with an icon), used for the just-copied clipboard text and
 *   Talorys suggestions.
 */
class SuggestionStripView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    data class Slot(
        val text: String,
        val bold: Boolean = false,
        val chip: Boolean = false,
        @DrawableRes val icon: Int = 0,
        val description: String? = null,
        val onClick: () -> Unit,
        val onLongClick: (() -> Unit)? = null,
    )

    data class Tool(@DrawableRes val icon: Int, val description: String, val badge: Boolean = false, val onClick: () -> Unit)

    private var toolbar = true
    private var tools: List<Tool> = emptyList()
    private var slots: List<Slot?> = listOf(null, null, null)
    var onExpandToolbar: (() -> Unit)? = null
    var onMic: (() -> Unit)? = null
    var micVisible = true
        set(v) { if (field != v) { field = v; relayout(); invalidate() } }
    var micDescription: String = ""
    var expandDescription: String = ""
    /** Mirror the side slots (literal typed word on the right) for RTL typing. */
    var rtl = false
        set(v) { if (field != v) { field = v; relayout(); invalidate() } }

    private val hitRects = ArrayList<RectF>()
    private val hitActions = ArrayList<Int>() // index into the virtual items
    private var pressed = -1
    private val handler = Handler(Looper.getMainLooper())
    private var longFired = false

    private var colorText = themeColor(R.attr.kbKeyText)
    private var colorHint = themeColor(R.attr.kbKeyHint)
    private var colorDivider = themeColor(R.attr.kbDivider)
    private var colorChip = themeColor(R.attr.kbFunctionKey)
    private var colorAccent = themeColor(R.attr.kbAccentKey)

    private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        textSize = sp(17f)
    }
    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val iconCache = HashMap<Int, Drawable>()
    private val buttonSize = dp(44f)
    private val iconSize = dp(22f).toInt()

    // Item model: 0 = expand chevron, 1 = mic, 10+i = slot i, 20+i = tool i
    private val itemExpand = 0
    private val itemMic = 1

    private val a11y = StripA11y()

    init {
        ViewCompat.setAccessibilityDelegate(this, a11y)
        isHapticFeedbackEnabled = true
    }

    fun reloadColors() {
        colorText = themeColor(R.attr.kbKeyText)
        colorHint = themeColor(R.attr.kbKeyHint)
        colorDivider = themeColor(R.attr.kbDivider)
        colorChip = themeColor(R.attr.kbFunctionKey)
        colorAccent = themeColor(R.attr.kbAccentKey)
        invalidate()
    }

    fun showToolbar(newTools: List<Tool>) {
        if (toolbar && newTools == tools) return
        toolbar = true
        tools = newTools
        relayout()
        invalidate()
        a11y.invalidateRoot()
    }

    fun showSuggestions(newSlots: List<Slot?>) {
        val s = List(3) { newSlots.getOrNull(it) }
        if (!toolbar && sameText(s, slots)) {
            // Same words: keep the drawing, just refresh the callbacks.
            slots = s
            return
        }
        toolbar = false
        slots = s
        relayout()
        invalidate()
        a11y.invalidateRoot()
    }

    val isToolbar: Boolean get() = toolbar

    private fun sameText(a: List<Slot?>, b: List<Slot?>): Boolean =
        a.indices.all { a[it]?.text == b[it]?.text && a[it]?.bold == b[it]?.bold && a[it]?.chip == b[it]?.chip }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val h = resources.getDimensionPixelSize(R.dimen.tk_kb_strip_height)
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), h)
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        relayout()
    }

    private val tmpChip = RectF()
    private val tmpText = RectF()
    private val tmpPressed = RectF()
    private val expandRect = RectF()
    private val micRect = RectF()
    private val slotRects = List(3) { RectF() }
    private val toolRects = ArrayList<RectF>()

    private fun relayout() {
        val w = width.toFloat(); val h = height.toFloat()
        if (w <= 0f || h <= 0f) return
        val pad = dp(4f)
        hitRects.clear(); hitActions.clear()
        // Mic on the end (right), expand chevron on the start (left); the strip itself is LTR.
        micRect.set(w - pad - buttonSize, (h - buttonSize) / 2, w - pad, (h + buttonSize) / 2)
        if (!micVisible) micRect.setEmpty()
        val right = if (micVisible) micRect.left else w - pad
        if (toolbar) {
            expandRect.setEmpty()
            toolRects.clear()
            val n = tools.size.coerceAtLeast(1)
            val cell = (right - pad) / n
            for (i in tools.indices) {
                val cx = pad + cell * i + cell / 2
                val r = RectF(cx - cell / 2, 0f, cx + cell / 2, h)
                toolRects += r
                hitRects += r; hitActions += 20 + i
            }
        } else {
            expandRect.set(pad, (h - buttonSize) / 2, pad + buttonSize, (h + buttonSize) / 2)
            hitRects += RectF(expandRect); hitActions += itemExpand
            val left = expandRect.right
            val cell = (right - left) / 3f
            for (i in 0..2) {
                slotRects[i].set(left + cell * i, 0f, left + cell * (i + 1), h)
            }
            for (i in 0..2) if (slots[slotAt(i)] != null) { hitRects += slotRects[i]; hitActions += 10 + slotAt(i) }
        }
        if (micVisible) { hitRects += RectF(micRect); hitActions += itemMic }
    }

    /** Visual position → slot index (side slots mirrored for RTL). */
    private fun slotAt(visual: Int): Int = if (rtl && visual != 1) 2 - visual else visual

    override fun onDraw(canvas: Canvas) {
        val h = height.toFloat()
        if (toolbar) {
            for (i in tools.indices) {
                val r = toolRects.getOrNull(i) ?: continue
                if (pressed == 20 + i) drawPressed(canvas, r)
                drawIcon(canvas, tools[i].icon, r.centerX(), r.centerY(), colorText)
                if (tools[i].badge) {
                    bgPaint.color = colorAccent
                    canvas.drawCircle(r.centerX() + iconSize * 0.55f, r.centerY() - iconSize * 0.5f, dp(4f), bgPaint)
                }
            }
        } else {
            if (pressed == itemExpand) drawPressed(canvas, expandRect)
            drawIcon(canvas, R.drawable.tk_ic_chevron_right, expandRect.centerX(), expandRect.centerY(), colorHint, ltr = true)
            for (v in 0..2) {
                val slot = slots[slotAt(v)] ?: continue
                val r = slotRects[v]
                if (slot.chip) {
                    val chip = tmpChip.apply { set(r.left + dp(4f), h * 0.18f, r.right - dp(4f), h * 0.82f) }
                    bgPaint.color = if (pressed == 10 + slotAt(v)) ColorUtils.blendARGB(colorChip, colorText, 0.15f) else colorChip
                    canvas.drawRoundRect(chip, chip.height() / 2, chip.height() / 2, bgPaint)
                    var textLeft = chip.left + dp(10f)
                    if (slot.icon != 0) {
                        drawIcon(canvas, slot.icon, chip.left + dp(10f) + iconSize * 0.4f, chip.centerY(), colorText, size = (iconSize * 0.8f).toInt())
                        textLeft += iconSize * 0.8f + dp(4f)
                    }
                    drawText(canvas, slot.text, slot.bold, tmpText.apply { set(textLeft, chip.top, chip.right - dp(10f), chip.bottom) }, 15f)
                } else {
                    if (pressed == 10 + slotAt(v)) drawPressed(canvas, r)
                    drawText(canvas, slot.text, slot.bold, r, 17f)
                }
            }
            bgPaint.color = colorDivider
            val dh = dp(10f)
            for (v in 0..1) {
                val a = slots[slotAt(v)]; val b = slots[slotAt(v + 1)]
                if (a != null && b != null && !a.chip && !b.chip) {
                    val x = slotRects[v].right
                    canvas.drawRect(x - dp(0.5f), h / 2 - dh, x + dp(0.5f), h / 2 + dh, bgPaint)
                }
            }
        }
        if (micVisible) {
            if (pressed == itemMic) drawPressed(canvas, micRect)
            drawIcon(canvas, R.drawable.tk_ic_mic, micRect.centerX(), micRect.centerY(), colorText)
        }
    }

    private fun drawText(canvas: Canvas, text: String, bold: Boolean, r: RectF, sizeSp: Float) {
        textPaint.textSize = sp(sizeSp)
        textPaint.typeface = if (bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        textPaint.color = colorText
        val avail = (r.width() - dp(8f)).coerceAtLeast(dp(10f))
        val shown = TextUtils.ellipsize(text, textPaint, avail, TextUtils.TruncateAt.END).toString()
        val y = r.centerY() - (textPaint.descent() + textPaint.ascent()) / 2
        canvas.drawText(shown, r.centerX(), y, textPaint)
    }

    private fun drawPressed(canvas: Canvas, r: RectF) {
        bgPaint.color = ColorUtils.setAlphaComponent(colorText, 0x1F)
        tmpPressed.set(r.left + dp(2f), r.top + dp(4f), r.right - dp(2f), r.bottom - dp(4f))
        canvas.drawRoundRect(tmpPressed, dp(18f), dp(18f), bgPaint)
    }

    private fun drawIcon(canvas: Canvas, @DrawableRes res: Int, cx: Float, cy: Float, color: Int, size: Int = iconSize, ltr: Boolean = false) {
        val d = iconCache.getOrPut(res) { AppCompatResources.getDrawable(context, res)!!.mutate() }
        d.setTint(color)
        d.layoutDirection = if (ltr) LAYOUT_DIRECTION_LTR else layoutDirection
        d.setBounds((cx - size / 2).toInt(), (cy - size / 2).toInt(), (cx + size / 2).toInt(), (cy + size / 2).toInt())
        d.draw(canvas)
    }

    // ---- touch ----

    private fun itemAt(x: Float, y: Float): Int {
        for (i in hitRects.indices) if (hitRects[i].contains(x, y)) return hitActions[i]
        return -1
    }

    private val longPressRunnable = Runnable {
        val item = pressed
        val lc = if (item in 10..12) slots[item - 10]?.onLongClick else null
        if (lc != null) {
            longFired = true
            performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS)
            lc()
            pressed = -1
            invalidate()
        }
    }

    @android.annotation.SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                pressed = itemAt(event.x, event.y)
                longFired = false
                if (pressed >= 0) handler.postDelayed(longPressRunnable, 450)
                invalidate()
            }
            MotionEvent.ACTION_MOVE -> {
                if (pressed >= 0 && itemAt(event.x, event.y) != pressed) {
                    handler.removeCallbacks(longPressRunnable)
                    pressed = -1
                    invalidate()
                }
            }
            MotionEvent.ACTION_UP -> {
                handler.removeCallbacks(longPressRunnable)
                val item = pressed
                pressed = -1
                invalidate()
                if (item >= 0 && !longFired) { performClick(); activate(item) }
            }
            MotionEvent.ACTION_CANCEL -> {
                handler.removeCallbacks(longPressRunnable)
                pressed = -1
                invalidate()
            }
        }
        return true
    }

    override fun performClick(): Boolean = super.performClick()

    private fun activate(item: Int): Boolean {
        when {
            item == itemExpand -> onExpandToolbar?.invoke()
            item == itemMic -> onMic?.invoke()
            item in 10..12 -> slots[item - 10]?.onClick?.invoke() ?: return false
            item >= 20 -> tools.getOrNull(item - 20)?.onClick?.invoke() ?: return false
            else -> return false
        }
        return true
    }

    private fun describe(item: Int): String = when {
        item == itemExpand -> expandDescription
        item == itemMic -> micDescription
        item in 10..12 -> slots[item - 10]?.let { it.description ?: it.text } ?: ""
        item >= 20 -> tools.getOrNull(item - 20)?.description ?: ""
        else -> ""
    }

    override fun dispatchHoverEvent(event: MotionEvent): Boolean = a11y.dispatchHoverEvent(event) || super.dispatchHoverEvent(event)

    private inner class StripA11y : ExploreByTouchHelper(this@SuggestionStripView) {
        override fun getVirtualViewAt(x: Float, y: Float): Int = itemAt(x, y).takeIf { it >= 0 } ?: HOST_ID
        override fun getVisibleVirtualViews(virtualViewIds: MutableList<Int>) { virtualViewIds.addAll(hitActions) }

        @Suppress("DEPRECATION")
        override fun onPopulateNodeForVirtualView(virtualViewId: Int, node: AccessibilityNodeInfoCompat) {
            val i = hitActions.indexOf(virtualViewId)
            node.contentDescription = describe(virtualViewId)
            node.className = "android.widget.Button"
            node.addAction(AccessibilityNodeInfoCompat.ACTION_CLICK)
            if (virtualViewId in 10..12 && slots[virtualViewId - 10]?.onLongClick != null) node.addAction(AccessibilityNodeInfoCompat.ACTION_LONG_CLICK)
            val r = android.graphics.Rect()
            (hitRects.getOrNull(i) ?: RectF(0f, 0f, 1f, 1f)).roundOut(r)
            node.setBoundsInParent(r)
        }

        override fun onPerformActionForVirtualView(virtualViewId: Int, action: Int, arguments: Bundle?): Boolean = when (action) {
            AccessibilityNodeInfoCompat.ACTION_CLICK -> activate(virtualViewId)
            AccessibilityNodeInfoCompat.ACTION_LONG_CLICK -> slots.getOrNull(virtualViewId - 10)?.onLongClick?.let { it(); true } ?: false
            else -> false
        }
    }

    private fun themeColor(@AttrRes attr: Int): Int {
        val tv = TypedValue()
        context.theme.resolveAttribute(attr, tv, true)
        return if (tv.resourceId != 0) context.getColor(tv.resourceId) else tv.data
    }

    private fun dp(v: Float) = v * resources.displayMetrics.density
    private fun sp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v, resources.displayMetrics)
}
