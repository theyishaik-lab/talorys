package com.talorys.keyboard.keyboard

import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.view.View.MeasureSpec
import com.talorys.keyboard.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode

/**
 * The IME window hands the input view an AT_MOST spec of the whole screen height. The view must
 * come back at its natural height (strip + board), not fill the screen, and the Talorys panel
 * must take exactly the board's height.
 */
@RunWith(RobolectricTestRunner::class)
// Legacy (non-native) modes: the native runtime has no Linux aarch64 build (CI/dev boxes vary).
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
class InputViewLayoutTest {

    private val screenW = 1080
    private val screenH = 2400

    private fun inflate(): View {
        val ctx = ContextThemeWrapper(RuntimeEnvironment.getApplication(), R.style.Theme_Talorys_Keyboard)
        return LayoutInflater.from(ctx).inflate(R.layout.tk_keyboard_input_view, null, false)
    }

    private fun measure(v: View) {
        v.measure(
            MeasureSpec.makeMeasureSpec(screenW, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(screenH, MeasureSpec.AT_MOST),
        )
        v.layout(0, 0, v.measuredWidth, v.measuredHeight)
    }

    private fun expectedHeight(v: View): Int {
        val res = v.resources
        val strip = res.getDimensionPixelSize(R.dimen.tk_kb_strip_height)
        val kb = v.findViewById<View>(R.id.keyboard)
        return strip + kb.measuredHeight
    }

    @Test
    fun keyboardIsNaturalHeightNotFullScreen() {
        val v = inflate()
        measure(v)
        assertTrue("input view ${v.measuredHeight}px must be well under the screen", v.measuredHeight < screenH / 2)
        assertEquals(expectedHeight(v), v.measuredHeight)
        // 1.4.0: default row 56dp (Gboard-like; the key-height setting changes it). xxhdpi = 3 px/dp.
        val kb = v.findViewById<KeyboardView>(R.id.keyboard)
        assertEquals(168f, v.resources.getDimension(R.dimen.tk_kb_key_height), 1f)
        assertEquals((5 * 168f).toInt() + kb.paddingTop + kb.paddingBottom, kb.measuredHeight)
        assertEquals(144 + 840 + kb.paddingTop + kb.paddingBottom, v.measuredHeight)
        // The preview overlay is stretched to exactly the input view, no more.
        assertEquals(v.measuredHeight, v.findViewById<View>(R.id.key_preview).measuredHeight)
    }

    @Test
    fun panelKeepsKeyboardHeight() {
        val v = inflate()
        measure(v)
        val closedH = v.measuredHeight
        val kb = v.findViewById<View>(R.id.keyboard)
        val panel = v.findViewById<View>(R.id.talorys_panel)
        // Same as setPanelOpen(true): board invisible (keeps its size), panel shown.
        kb.visibility = View.INVISIBLE
        panel.visibility = View.VISIBLE
        measure(v)
        assertEquals("no height jump when the panel opens", closedH, v.measuredHeight)
        assertEquals(kb.measuredHeight, panel.measuredHeight)
        // With nav-bar padding added (edge-to-edge gesture nav), everything grows together.
        kb.setPadding(kb.paddingLeft, kb.paddingTop, kb.paddingRight, kb.paddingBottom + 63)
        panel.setPadding(0, 0, 0, 63)
        measure(v)
        assertEquals(closedH + 63, v.measuredHeight)
        assertEquals(kb.measuredHeight, panel.measuredHeight)
    }

    @Test
    fun keyHeightSettingChangesTheBoardAndPanelsFollow() {
        val v = inflate()
        val kb = v.findViewById<KeyboardView>(R.id.keyboard)
        kb.rowHeight = 62.5f * 3 // the 1.3.0 "+25%" preset
        measure(v)
        assertEquals((5 * 187.5f).toInt() + kb.paddingTop + kb.paddingBottom, kb.measuredHeight)
        val clip = v.findViewById<View>(R.id.clip_panel)
        kb.visibility = View.INVISIBLE
        clip.visibility = View.VISIBLE
        measure(v)
        assertEquals(kb.measuredHeight, clip.measuredHeight)
    }

    @Test
    fun panelActionsAreLabelled() {
        val v = inflate()
        for (id in listOf(R.id.btn_ask, R.id.btn_settings, R.id.btn_hide, R.id.btn_back)) {
            val b = v.findViewById<com.google.android.material.button.MaterialButton>(id)
            assertTrue("action $id needs a visible label", b.text.isNotBlank())
        }
        assertTrue(v.findViewById<com.google.android.material.chip.Chip>(R.id.chip_setup).text.isNotBlank())
    }
}
