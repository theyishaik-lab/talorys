package com.talorys.keyboard.clip

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ClipboardStoreTest {

    private var now = 1_000_000L
    private fun store(max: Int = 50, expiry: Long = 3_600_000L) = ClipboardStore(max, expiry) { now }

    @Test fun newestFirstAndDeduplicated() {
        val s = store()
        s.add("one"); now += 10; s.add("two"); now += 10; s.add("one")
        assertEquals(listOf("one", "two"), s.list().map { it.text })
        assertEquals("one", s.latest()?.text)
    }

    @Test fun blankAndSensitiveClipsAreSkipped() {
        val s = store()
        assertNull(s.add("   "))
        assertNull(s.add(null))
        assertNull(s.add("hunter2", sensitive = true))
        assertEquals(0, s.size())
    }

    @Test fun keepsAtMostFiftyUnpinned() {
        val s = store()
        val first = s.add("pinned me")!!
        s.setPinned(first.id, true)
        repeat(60) { now += 1; s.add("clip $it") }
        val items = s.list()
        assertEquals(51, items.size)
        assertTrue(items.first().pinned)
        assertEquals("clip 59", items[1].text)
        assertFalse(items.any { it.text == "clip 9" })
        assertTrue(items.any { it.text == "clip 10" })
    }

    @Test fun unpinnedExpireAfterAnHourPinnedStay() {
        val s = store()
        val a = s.add("keep")!!
        s.add("drop")
        s.setPinned(a.id, true)
        now += 3_600_001L
        assertEquals(listOf("keep"), s.list().map { it.text })
        // "never" expiry keeps everything
        val n = ClipboardStore(50, 0) { now }
        n.add("x"); now += 100L * 86_400_000L
        assertEquals(1, n.list().size)
    }

    @Test fun clearKeepsPinnedUnlessAsked() {
        val s = store()
        val a = s.add("a")!!
        s.add("b")
        s.setPinned(a.id, true)
        s.clear()
        assertEquals(listOf("a"), s.list().map { it.text })
        s.clear(includePinned = true)
        assertEquals(0, s.size())
    }

    @Test fun removeAndUnpin() {
        val s = store(max = 1)
        val a = s.add("a")!!
        s.setPinned(a.id, true)
        now += 1; s.add("b")
        assertEquals(2, s.size())
        // Unpinning "a" puts two unpinned items over the limit of 1: the older one goes.
        s.setPinned(a.id, false)
        assertEquals(listOf("b"), s.list().map { it.text })
        assertTrue(s.remove(s.list().first().id))
        assertEquals(0, s.size())
    }

    @Test fun saveLoadRoundTripKeepsPinsAndOrder() {
        val s = store()
        val a = s.add("first")!!; now += 5
        s.add("second"); now += 5
        s.add("שלום עולם")
        s.setPinned(a.id, true)
        val json = s.save()
        val t = store()
        t.add("copied before load") // the listener may fire before the saved file is read
        t.load(json)
        val texts = t.list().map { it.text }
        assertEquals("first", texts.first())
        assertTrue("copied before load" in texts)
        assertEquals(4, texts.size)
        assertTrue(t.list().first().pinned)
        // ids stay unique
        assertEquals(4, t.list().map { it.id }.toSet().size)
    }

    @Test fun corruptFileStartsEmpty() {
        val s = store()
        s.load("{not json")
        assertEquals(0, s.size())
        assertNotNull(s.add("ok"))
    }

    @Test fun longTextIsCapped() {
        val s = store()
        val item = s.add("x".repeat(ClipboardStore.MAX_TEXT + 500))!!
        assertEquals(ClipboardStore.MAX_TEXT, item.text.length)
    }

    @Test fun policySkipsSensitiveAndPasswordClips() {
        assertTrue(ClipPolicy.skip(flaggedSensitive = true, fromPasswordField = false))
        assertTrue(ClipPolicy.skip(flaggedSensitive = false, fromPasswordField = true))
        assertTrue(ClipPolicy.skip(false, false, "Password"))
        assertTrue(ClipPolicy.skip(false, false, "OTP code"))
        assertFalse(ClipPolicy.skip(false, false, "Copied text"))
        assertFalse(ClipPolicy.skip(false, false, null))
    }
}
