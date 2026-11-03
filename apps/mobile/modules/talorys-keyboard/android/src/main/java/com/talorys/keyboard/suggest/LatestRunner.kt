package com.talorys.keyboard.suggest

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * "Latest request wins": each [submit] cancels the previous request, waits [debounceMs] (so a
 * burst of keystrokes computes once), runs the work on [worker] and delivers the result on the
 * [scope]'s thread (the main thread in the keyboard) unless a newer request arrived meanwhile.
 * A stale result is never delivered, so the strip can't flash an old word.
 */
class LatestRunner(
    private val scope: CoroutineScope,
    private val worker: CoroutineDispatcher,
    private val debounceMs: Long = 0,
) {
    private var job: Job? = null
    private var seq = 0L

    /** [compute] may poll the probe it gets and stop early (throw CancellationException) once superseded. */
    fun <T> submit(compute: (cancelled: () -> Boolean) -> T, deliver: (T) -> Unit) {
        job?.cancel()
        val mySeq = ++seq
        job = scope.launch {
            if (debounceMs > 0) delay(debounceMs)
            val result = withContext(worker) { compute { mySeq != seq } }
            if (mySeq == seq) deliver(result)
        }
    }

    fun cancel() {
        job?.cancel()
        seq++
    }

    val busy: Boolean get() = job?.isActive == true
}

/** A small thread-safe LRU cache (analysis results keyed by word + context). */
class LruCache<K, V>(private val max: Int) {
    private val map = object : LinkedHashMap<K, V>(max * 2, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<K, V>?): Boolean = size > max
    }

    @Synchronized operator fun get(k: K): V? = map[k]
    @Synchronized operator fun set(k: K, v: V) { map[k] = v }
    @Synchronized fun clear() = map.clear()
    @Synchronized fun size() = map.size
}
