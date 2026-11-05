package com.talorys.localllm

/**
 * Pure logic of the local-model module, kept free of Android types so it runs as plain JVM unit
 * tests (src/test). Mirrors packages/shared/src/device.ts where the two must agree.
 */
object Logic {
    private const val GB = 1024.0 * 1024.0 * 1024.0

    /**
     * "ok" | "warn" | "block" for a model on a phone with [totalRamBytes] (ActivityManager.MemoryInfo.totalMem
     * reports a little less than the marketed size, hence the 0.5 GB slack). Same rule as ramVerdict() in TS.
     */
    fun ramVerdict(spec: ModelSpec, totalRamBytes: Long): String {
        val gb = totalRamBytes / GB + 0.5
        return when {
            gb < spec.minRamGb -> "block"
            gb < spec.recommendedRamGb -> "warn"
            else -> "ok"
        }
    }

    /** Backends to try, in order: the preferred one first, CPU always last. */
    fun backendOrder(preferGpu: Boolean): List<String> = if (preferGpu) listOf("gpu", "cpu") else listOf("cpu")

    /**
     * Where to resume a download. A partial file longer than the model is corrupt (start over); a
     * complete one needs no request.
     */
    fun resumeOffset(partialBytes: Long, totalBytes: Long): Long = when {
        partialBytes <= 0L -> 0L
        partialBytes > totalBytes -> 0L
        else -> partialBytes
    }

    /**
     * Whether a ranged response really continues at [offset]: 206 with a Content-Range starting there.
     * A server that ignores Range answers 200 with the whole file, and the partial must be discarded.
     */
    fun rangeHonoured(status: Int, contentRange: String?, offset: Long): Boolean {
        if (offset == 0L) return status == 200 || status == 206
        if (status != 206 || contentRange == null) return false
        val m = Regex("""bytes\s+(\d+)-(\d+)/(\d+|\*)""").find(contentRange) ?: return false
        return m.groupValues[1].toLongOrNull() == offset
    }

    /** Enough free space for the rest of the download plus a 200 MB margin. */
    fun hasSpace(freeBytes: Long, remainingBytes: Long): Boolean = freeBytes >= remainingBytes + 200L * 1024 * 1024

    /** Throttles progress events: at most every [minMs], always the final one. */
    class Throttle(private val minMs: Long) {
        private var last = Long.MIN_VALUE / 2
        fun ready(nowMs: Long, final: Boolean = false): Boolean {
            if (final || nowMs - last >= minMs) {
                last = nowMs
                return true
            }
            return false
        }
    }

    /**
     * Removes <think>…</think> from a streamed answer (deltas in order). LiteRT-LM normally routes
     * Spark's reasoning to its "thought" channel; this is the guard for a runtime that leaks it.
     * Same behaviour as ThinkStripper in packages/shared/src/device.ts.
     */
    class ThinkStripper {
        private val buf = StringBuilder()
        private var inThink = false
        var started = false
            private set

        fun push(delta: String): String {
            buf.append(delta)
            val out = StringBuilder()
            while (true) {
                if (inThink) {
                    val end = buf.indexOf("</think>")
                    if (end == -1) {
                        val keep = minOf(7, buf.length)
                        buf.delete(0, buf.length - keep)
                        break
                    }
                    buf.delete(0, end + 8)
                    inThink = false
                    continue
                }
                val start = buf.indexOf("<think>")
                if (start == -1) {
                    val hold = partialTail(buf, "<think>")
                    out.append(buf, 0, buf.length - hold)
                    buf.delete(0, buf.length - hold)
                    break
                }
                out.append(buf, 0, start)
                buf.delete(0, start + 7)
                inThink = true
            }
            var s = out.toString().replace("</think>", "")
            if (!started) s = s.trimStart()
            if (s.isNotEmpty()) started = true
            return s
        }

        fun end(): String {
            val rest = if (inThink) "" else buf.toString().replace("</think>", "")
            buf.setLength(0)
            return if (started) rest else rest.trimStart()
        }

        private fun partialTail(s: CharSequence, tag: String): Int {
            for (n in minOf(tag.length - 1, s.length) downTo 1) {
                if (s.endsWith(tag.substring(0, n))) return n
            }
            return 0
        }
    }

    /** Exponential reconnect backoff for the bridge socket: 2 s → 4 s → … → 5 min. */
    fun reconnectDelayMs(failures: Int): Long {
        val n = failures.coerceIn(0, 12)
        return minOf(2_000L shl n, 5 * 60_000L)
    }

    /** Lower-case hex of a digest. */
    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
}
