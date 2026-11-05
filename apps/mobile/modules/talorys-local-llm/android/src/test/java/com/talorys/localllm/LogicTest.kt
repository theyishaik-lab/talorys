package com.talorys.localllm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Plain JVM tests of the module's pure logic (no device, no LiteRT-LM). */
class LogicTest {
    private val gb = 1024L * 1024 * 1024
    private val gemma = ModelSpecs.byId("gemma-4-e4b")!!
    private val spark = ModelSpecs.byId("spark-x2.5-1.7b")!!

    @Test fun ramVerdictBlocksGemmaUnderSixGb() {
        assertEquals("block", Logic.ramVerdict(gemma, (3.6 * gb).toLong()))
        assertEquals("warn", Logic.ramVerdict(gemma, (5.6 * gb).toLong()))
        assertEquals("ok", Logic.ramVerdict(gemma, (11.2 * gb).toLong()))
        assertEquals("ok", Logic.ramVerdict(spark, (3.6 * gb).toLong()))
    }

    @Test fun gpuFirstThenCpu() {
        assertEquals(listOf("gpu", "cpu"), Logic.backendOrder(true))
        assertEquals(listOf("cpu"), Logic.backendOrder(false))
    }

    @Test fun resumeOffsets() {
        assertEquals(0L, Logic.resumeOffset(0, 100))
        assertEquals(40L, Logic.resumeOffset(40, 100))
        assertEquals(0L, Logic.resumeOffset(140, 100))
    }

    @Test fun rangeMustContinueAtTheOffset() {
        assertTrue(Logic.rangeHonoured(200, null, 0))
        assertTrue(Logic.rangeHonoured(206, "bytes 500-999/1000", 500))
        assertFalse(Logic.rangeHonoured(206, "bytes 0-999/1000", 500))
        assertFalse(Logic.rangeHonoured(200, null, 500))
    }

    @Test fun spaceNeedsAMargin() {
        assertFalse(Logic.hasSpace(1000L * 1024 * 1024, 900L * 1024 * 1024))
        assertTrue(Logic.hasSpace(2000L * 1024 * 1024, 900L * 1024 * 1024))
    }

    @Test fun throttleLetsTheFinalEventThrough() {
        val t = Logic.Throttle(500)
        assertTrue(t.ready(0))
        assertFalse(t.ready(100))
        assertTrue(t.ready(100, final = true))
        assertTrue(t.ready(700))
    }

    @Test fun thinkBlocksAreStrippedAtAnySplit() {
        val full = "<think>let me think</think>\n\nThe answer is 42."
        for (cut in 1 until full.length) {
            val s = Logic.ThinkStripper()
            val out = s.push(full.substring(0, cut)) + s.push(full.substring(cut)) + s.end()
            assertEquals("cut at $cut", "The answer is 42.", out)
        }
    }

    @Test fun plainTextStreamsThrough() {
        val s = Logic.ThinkStripper()
        assertEquals("Hello ", s.push("Hello "))
        assertEquals("world ", s.push("world <"))
        assertEquals("<b>", s.push("b>"))
        assertEquals("", s.end())
    }

    @Test fun unterminatedThinkIsDropped() {
        val s = Logic.ThinkStripper()
        assertEquals("Answer.", s.push("Answer.<think>never") + s.end())
    }

    @Test fun reconnectBackoffIsCapped() {
        assertEquals(2_000L, Logic.reconnectDelayMs(0))
        assertEquals(4_000L, Logic.reconnectDelayMs(1))
        assertEquals(300_000L, Logic.reconnectDelayMs(50))
    }

    @Test fun specsArePinned() {
        for (m in ModelSpecs.ALL) {
            assertTrue(m.url.contains("/resolve/") && m.url.endsWith(m.file))
            assertEquals(64, m.sha256.length)
            assertNotNull(ModelSpecs.byId(m.id))
        }
        assertTrue(spark.maxOutputTokens >= 2048)
    }
}
