package com.talorys.keyboard.keyboard

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.util.TypedValue
import android.view.View
import androidx.core.graphics.ColorUtils
import com.talorys.keyboard.R
import kotlin.math.max

/**
 * Transparent overlay over the whole input view that draws the Gboard-style key-press preview
 * bubble above the pressed key (it may extend over the suggestion strip). Never takes touches.
 */
class KeyPreviewView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : View(context, attrs) {

    private var label: String? = null
    private val bubble = RectF()
    private var popup: List<String>? = null
    private var popupRects: List<RectF> = emptyList()
    private var popupSel = 0
    private val popupBg = RectF()

    private val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = themeColor(R.attr.kbPreview)
        setShadowLayer(dp(3f), 0f, dp(1f), ColorUtils.setAlphaComponent(0xFF000000.toInt(), 0x50))
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        color = themeColor(R.attr.kbKeyText)
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 30f, resources.displayMetrics)
    }
    private val selPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = themeColor(R.attr.kbAccentKey) }
    private val selTextColor = themeColor(R.attr.kbAccentKeyText)
    private val normalTextColor = themeColor(R.attr.kbKeyText)
    private val radius = dp(10f)

    init {
        isClickable = false
        isFocusable = false
        setWillNotDraw(false)
    }

    /**
     * Never contributes height. The IME root is a wrap_content FrameLayout; with View's default
     * measure an AT_MOST spec (the whole screen height) would make this overlay, and so the whole
     * keyboard window, fill the screen. The parent FrameLayout re-measures match_parent children
     * with EXACTLY its final size, so we still end up covering exactly the input view.
     */
    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val w = MeasureSpec.getSize(widthMeasureSpec)
        val h = if (MeasureSpec.getMode(heightMeasureSpec) == MeasureSpec.EXACTLY) MeasureSpec.getSize(heightMeasureSpec) else 0
        setMeasuredDimension(w, h)
    }

    /** [keyRect] is in this view's coordinates; null hides the bubble. */
    fun show(text: String?, keyRect: RectF?) {
        if (text == null || keyRect == null) {
            if (label != null) { label = null; invalidate() }
            return
        }
        label = text
        textPaint.textSize = (keyRect.height() * 0.62f).coerceIn(dp(20f), dp(34f))
        val w = max(keyRect.width() * 1.1f, dp(44f))
        val h = keyRect.height() * 1.3f
        var left = keyRect.centerX() - w / 2
        left = left.coerceIn(dp(2f), max(dp(2f), width - w - dp(2f)))
        val bottom = keyRect.top + keyRect.height() * 0.12f
        val top = max(0f, bottom - h)
        bubble.set(left, top, left + w, top + h)
        invalidate()
    }

    /**
     * Shows the long-press popup: [options] in [rects] (this view's coordinates), [selected]
     * highlighted. Null options hide it.
     */
    fun showPopup(options: List<String>?, rects: List<RectF>?, selected: Int) {
        if (options == null || rects == null || rects.isEmpty()) {
            if (popup != null) { popup = null; invalidate() }
            return
        }
        popup = options
        popupRects = rects
        popupSel = selected
        val pad = dp(5f)
        popupBg.set(rects.first().left - pad, rects.first().top - pad, rects.last().right + pad, rects.first().bottom + pad)
        if (popupBg.top < 0f) {
            val dy = -popupBg.top
            popupBg.offset(0f, dy)
            popupRects = rects.map { RectF(it.left, it.top + dy, it.right, it.bottom + dy) }
        }
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        popup?.let { opts ->
            canvas.drawRoundRect(popupBg, radius, radius, bgPaint)
            val ts = textPaint.textSize
            textPaint.textSize = (popupRects.first().height() * 0.5f).coerceIn(dp(16f), dp(28f))
            for (i in opts.indices) {
                val r = popupRects.getOrNull(i) ?: continue
                if (i == popupSel) canvas.drawRoundRect(r, radius * 0.8f, radius * 0.8f, selPaint)
                textPaint.color = if (i == popupSel) selTextColor else normalTextColor
                canvas.drawText(opts[i], r.centerX(), r.centerY() - (textPaint.descent() + textPaint.ascent()) / 2, textPaint)
            }
            textPaint.textSize = ts
            textPaint.color = normalTextColor
            return
        }
        val l = label ?: return
        canvas.drawRoundRect(bubble, radius, radius, bgPaint)
        val y = bubble.centerY() - (textPaint.descent() + textPaint.ascent()) / 2
        canvas.drawText(l, bubble.centerX(), y, textPaint)
    }

    private fun themeColor(attr: Int): Int {
        val tv = TypedValue()
        context.theme.resolveAttribute(attr, tv, true)
        return if (tv.resourceId != 0) context.getColor(tv.resourceId) else tv.data
    }

    private fun dp(v: Float) = v * resources.displayMetrics.density
}
