package com.talorys.keyboard.keyboard

import android.os.Looper
import android.os.SystemClock
import android.view.ContextThemeWrapper
import android.view.MotionEvent
import android.view.View.MeasureSpec
import com.talorys.keyboard.R
import com.talorys.keyboard.suggest.Pt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import org.robolectric.annotation.SQLiteMode
import java.time.Duration

/** Touch behaviour of the key board: taps, hit boxes, popups, space slide, backspace swipe, repeat. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.LEGACY)
@SQLiteMode(SQLiteMode.Mode.LEGACY)
@ConscryptMode(ConscryptMode.Mode.OFF)
@LooperMode(LooperMode.Mode.PAUSED)
@Config(sdk = [35], qualifiers = "w411dp-h914dp-xxhdpi")
class KeyboardViewTouchTest {

    private lateinit var kb: KeyboardView
    private val events = ArrayList<String>()
    private val texts = ArrayList<String>()
    private var touches = ArrayList<Pt?>()

    @Before fun setUp() {
        val ctx = ContextThemeWrapper(RuntimeEnvironment.getApplication(), R.style.Theme_Talorys_Keyboard)
        kb = KeyboardView(ctx)
        kb.listener = object : KeyboardView.Listener {
            override fun onKey(key: Key, touch: Pt?) { events += "key:" + (if (key.code == Codes.CHAR) key.label else key.code.toString()); touches += touch }
            override fun onLongPress(key: Key): Boolean = false
            override fun onKeyDown(key: Key) { events += "down" }
            override fun onText(text: String) { texts += text }
            override fun onGesture(path: List<Pt>) { events += "gesture" }
            override fun onCursorMove(steps: Int) { events += "cursor:$steps" }
            override fun onDeleteSwipe(words: Int, done: Boolean) { events += "delswipe:$words:$done" }
        }
        kb.setKeys(Layouts.english(FieldFlavor.TEXT, true))
        kb.measure(MeasureSpec.makeMeasureSpec(1080, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        kb.layout(0, 0, 1080, kb.measuredHeight)
    }

    private var downTime = 0L
    private fun ev(action: Int, x: Float, y: Float) {
        if (action == MotionEvent.ACTION_DOWN) downTime = SystemClock.uptimeMillis()
        val e = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0)
        kb.onTouchEvent(e)
        e.recycle()
    }

    private fun idle(ms: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(ms))

    private fun centre(label: String): Pt = kb.letterCenters()[label[0]]!!
    private val rowH get() = kb.letterKeyHeight()
    private val keyW get() = kb.letterKeyWidth()
    /** Bottom row (space / delete live in rows 4 and 3). */
    private val spaceY get() = rowH * 4.5f
    private val deleteX get() = 1080f - keyW * 0.6f
    private val deleteY get() = rowH * 3.5f

    @Test fun tapTypesTheKeyOnRelease() {
        val p = centre("g")
        ev(MotionEvent.ACTION_DOWN, p.x, p.y)
        assertEquals(listOf("down"), events)
        ev(MotionEvent.ACTION_UP, p.x, p.y)
        assertEquals(listOf("down", "key:g"), events)
        assertNotNull("letters report where they were hit", touches.last())
    }

    @Test fun gapsAndEdgesBelongToAKey() {
        // Left of 'a' (the half-key spacer of the home row) still types 'a'.
        val a = centre("a")
        ev(MotionEvent.ACTION_DOWN, 3f, a.y)
        ev(MotionEvent.ACTION_UP, 3f, a.y)
        assertEquals("key:a", events.last())
    }

    @Test fun borderTapFollowsTheLanguageModel() {
        val q = centre("q"); val w = centre("w")
        kb.nextCharProbs = mapOf('w' to 0.9f, 'q' to 0.001f)
        val x = q.x + (w.x - q.x) * 0.47f // still inside q, near the border
        ev(MotionEvent.ACTION_DOWN, x, q.y); ev(MotionEvent.ACTION_UP, x, q.y)
        assertEquals("key:w", events.last())
        // Deep inside q it stays q.
        ev(MotionEvent.ACTION_DOWN, q.x, q.y); ev(MotionEvent.ACTION_UP, q.x, q.y)
        assertEquals("key:q", events.last())
    }

    @Test fun longPressOpensPopupAndSlideChooses() {
        val e = centre("e")
        ev(MotionEvent.ACTION_DOWN, e.x, e.y)
        idle(KeyboardView.LONG_PRESS_MS + 20)
        // Slide right over the popup cells: the 1st is the hint, then the digit, then accents.
        ev(MotionEvent.ACTION_MOVE, e.x + keyW * 2.0f, e.y - rowH)
        ev(MotionEvent.ACTION_UP, e.x + keyW * 2.0f, e.y - rowH)
        assertEquals(1, texts.size)
        val popup = Layouts.english(FieldFlavor.TEXT, true)[1].first { it.label == "e" }.popup!!
        assertTrue("${texts[0]} in $popup", texts[0] in popup && texts[0] != popup[0])
        assertTrue("no plain 'e' typed", "key:e" !in events)
    }

    @Test fun spaceSlideMovesTheCursor() {
        val x0 = 540f
        ev(MotionEvent.ACTION_DOWN, x0, spaceY)
        ev(MotionEvent.ACTION_MOVE, x0 + keyW * 0.7f, spaceY)
        ev(MotionEvent.ACTION_MOVE, x0 + keyW * 2.1f, spaceY)
        ev(MotionEvent.ACTION_UP, x0 + keyW * 2.1f, spaceY)
        val steps = events.filter { it.startsWith("cursor:") }.sumOf { it.removePrefix("cursor:").toInt() }
        assertEquals(5, steps)
        assertTrue("no space typed after a slide", events.none { it == "key:${Codes.SPACE}" })
    }

    @Test fun backspaceSwipeLeftSelectsWords() {
        ev(MotionEvent.ACTION_DOWN, deleteX, deleteY)
        assertEquals("key:${Codes.DELETE}", events.last()) // instant delete on touch-down
        ev(MotionEvent.ACTION_MOVE, deleteX - keyW * 1.3f, deleteY)
        ev(MotionEvent.ACTION_MOVE, deleteX - keyW * 2.2f, deleteY)
        ev(MotionEvent.ACTION_UP, deleteX - keyW * 2.2f, deleteY)
        val swipes = events.filter { it.startsWith("delswipe") }
        assertTrue(swipes.toString(), swipes.first() == "delswipe:1:false")
        assertTrue(swipes.toString(), swipes.last() == "delswipe:2:true")
    }

    @Test fun backspaceRepeatAcceleratesThenDeletesWords() {
        ev(MotionEvent.ACTION_DOWN, deleteX, deleteY)
        idle(KeyboardView.REPEAT_START_MS + 3000)
        ev(MotionEvent.ACTION_UP, deleteX, deleteY)
        val chars = events.count { it == "key:${Codes.DELETE}" }
        val words = events.count { it == "key:${Codes.DELETE_WORD}" }
        assertTrue("chars $chars", chars > KeyboardView.WORD_DELETE_AFTER)
        assertTrue("words $words", words >= 1)
    }

    @Test fun oneHandedNarrowsTheBoard() {
        val before = kb.letterKeyWidth()
        kb.oneHanded = 1
        assertEquals(before * KeyboardView.ONE_HANDED_WIDTH, kb.letterKeyWidth(), 1f)
        // Right-aligned: 'p' sits at the right edge.
        assertTrue(kb.letterCenters()['q']!!.x > 1080f * (1 - KeyboardView.ONE_HANDED_WIDTH))
    }
}
