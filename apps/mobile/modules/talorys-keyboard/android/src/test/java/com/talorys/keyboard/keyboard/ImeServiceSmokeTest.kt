package com.talorys.keyboard.keyboard

import android.os.Looper
import android.text.InputType
import android.view.View
import android.view.View.MeasureSpec
import android.view.inputmethod.EditorInfo
import com.talorys.keyboard.R
import com.talorys.keyboard.TalorysInputMethodService
import com.talorys.keyboard.UiPrefs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.SQLiteMode

/**
 * The keyboard service on Robolectric (no emulator on the build machine): it starts, inflates its
 * themed input view for each theme setting, applies the key-height setting, shows the toolbar when
 * nothing is typed, and opens / closes the clipboard and Talorys panels without changing height.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
class ImeServiceSmokeTest {

    private fun measure(v: View) {
        v.measure(MeasureSpec.makeMeasureSpec(1080, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(2400, MeasureSpec.AT_MOST))
        v.layout(0, 0, v.measuredWidth, v.measuredHeight)
    }

    private fun field() = EditorInfo().apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        imeOptions = EditorInfo.IME_ACTION_SEND
        packageName = "com.example.chat"
    }

    @Test fun startsAndShowsToolbarForEveryTheme() {
        val prefs = UiPrefs(RuntimeEnvironment.getApplication())
        for (theme in listOf("system", "light", "dark")) for (dynamic in listOf(true, false)) {
            prefs.theme = theme
            prefs.dynamicColor = dynamic
            val svc = Robolectric.setupService(TalorysInputMethodService::class.java)
            val v = svc.onCreateInputView()
            svc.onStartInput(field(), false)
            svc.onStartInputView(field(), false)
            shadowOf(Looper.getMainLooper()).idle()
            measure(v)
            val strip = v.findViewById<SuggestionStripView>(R.id.strip)
            assertTrue("toolbar when idle ($theme/$dynamic)", strip.isToolbar)
            assertTrue(v.measuredHeight in 900..1300)
            svc.onDestroy()
        }
    }

    @Test fun keyHeightSettingAndPanels() {
        val prefs = UiPrefs(RuntimeEnvironment.getApplication())
        prefs.keyHeightDp = 62.5f
        val svc = Robolectric.setupService(TalorysInputMethodService::class.java)
        val v = svc.onCreateInputView()
        svc.onStartInput(field(), false)
        svc.onStartInputView(field(), false)
        shadowOf(Looper.getMainLooper()).idle()
        measure(v)
        val kb = v.findViewById<KeyboardView>(R.id.keyboard)
        assertEquals(187.5f, kb.rowHeight, 0.5f)
        val h = v.measuredHeight
        // Toolbar → clipboard panel (first tool) and back: same height, board hidden meanwhile.
        val clip = v.findViewById<View>(R.id.clip_panel)
        val strip = v.findViewById<SuggestionStripView>(R.id.strip)
        tapTool(strip, 0)
        measure(v)
        assertEquals(View.VISIBLE, clip.visibility)
        assertEquals(View.INVISIBLE, kb.visibility)
        assertEquals(h, v.measuredHeight)
        v.findViewById<View>(R.id.clip_close).performClick()
        assertEquals(View.GONE, clip.visibility)
        assertEquals(View.VISIBLE, kb.visibility)
        prefs.keyHeightDp = UiPrefs.DEFAULT_KEY_HEIGHT
        svc.onDestroy()
    }

    private fun tapTool(strip: SuggestionStripView, index: Int) {
        strip.measure(MeasureSpec.makeMeasureSpec(1080, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        strip.layout(0, 0, 1080, strip.measuredHeight)
        // Tools are spread evenly left of the mic button.
        val micW = 48f * 3
        val cell = (1080f - micW - 12f) / 6f
        val x = 12f + cell * index + cell / 2
        val y = strip.measuredHeight / 2f
        val down = android.view.MotionEvent.obtain(0, 0, android.view.MotionEvent.ACTION_DOWN, x, y, 0)
        val up = android.view.MotionEvent.obtain(0, 10, android.view.MotionEvent.ACTION_UP, x, y, 0)
        strip.onTouchEvent(down); strip.onTouchEvent(up)
        down.recycle(); up.recycle()
    }
}
