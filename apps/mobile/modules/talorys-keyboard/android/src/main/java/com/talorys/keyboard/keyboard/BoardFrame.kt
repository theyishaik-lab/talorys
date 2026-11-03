package com.talorys.keyboard.keyboard

import android.content.Context
import android.util.AttributeSet
import android.widget.FrameLayout
import androidx.core.view.isEmpty

/**
 * Holds the key board and, stacked on it, the Talorys panel. The FIRST child (the board) sets the
 * height at its natural size; every other child is measured with EXACTLY that height, whatever its
 * own layout params say. So the panel always takes the board's place (no height jump when it
 * opens), and no child can stretch the IME window to the full screen height.
 * The board should be made INVISIBLE (not GONE) while the panel shows, so it keeps its size.
 */
class BoardFrame @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : FrameLayout(context, attrs) {

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = MeasureSpec.getSize(widthMeasureSpec)
        if (isEmpty()) {
            setMeasuredDimension(width, paddingTop + paddingBottom)
            return
        }
        val board = getChildAt(0)
        // Measure the board as wrap_content within the available width (height unconstrained).
        val childW = MeasureSpec.makeMeasureSpec(maxOf(0, width - paddingLeft - paddingRight), MeasureSpec.EXACTLY)
        board.measure(childW, MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        val boardH = board.measuredHeight
        val exactH = MeasureSpec.makeMeasureSpec(boardH, MeasureSpec.EXACTLY)
        for (i in 1 until childCount) {
            val c = getChildAt(i)
            if (c.visibility != GONE) c.measure(childW, exactH)
        }
        setMeasuredDimension(width, boardH + paddingTop + paddingBottom)
    }
}
