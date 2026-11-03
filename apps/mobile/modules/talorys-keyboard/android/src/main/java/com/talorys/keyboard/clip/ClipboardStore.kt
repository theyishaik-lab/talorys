package com.talorys.keyboard.clip

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** One clipboard history entry. */
@Serializable
data class ClipItem(val id: Long, val text: String, val time: Long, val pinned: Boolean = false)

@Serializable
private data class ClipFile(val schema: Int = 1, val items: List<ClipItem> = emptyList())

/**
 * Clipboard history (pure Kotlin, thread-safe, unit-tested). Newest first; pinned items are kept
 * forever and don't count toward [maxUnpinned]; unpinned items expire after [expiryMs]
 * (0 = never). Copying the same text again moves it to the top instead of adding a duplicate.
 *
 * Persistence goes through [save] / [load] with a JSON string; the Android side encrypts it
 * (see [ClipboardHistory]).
 */
class ClipboardStore(
    var maxUnpinned: Int = DEFAULT_MAX,
    var expiryMs: Long = DEFAULT_EXPIRY_MS,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val items = ArrayList<ClipItem>()
    private var nextId = 1L

    /** Bumped on every change. */
    @Volatile var version = 0L
        private set

    /**
     * Adds a copied [text]. Returns the stored item, or null when it was skipped (blank or
     * [sensitive]).
     */
    @Synchronized
    fun add(text: CharSequence?, sensitive: Boolean = false): ClipItem? {
        if (sensitive || text == null) return null
        val t = text.toString().let { if (it.length > MAX_TEXT) it.substring(0, MAX_TEXT) else it }
        if (t.isBlank()) return null
        val now = clock()
        val existing = items.indexOfFirst { it.text == t }
        val item = if (existing >= 0) {
            val old = items.removeAt(existing)
            old.copy(time = now)
        } else {
            ClipItem(nextId++, t, now)
        }
        items.add(0, item)
        prune(now)
        version++
        return item
    }

    /** Pinned first (newest first), then the rest, newest first, after dropping expired items. */
    @Synchronized
    fun list(): List<ClipItem> {
        if (prune(clock())) version++
        return items.filter { it.pinned } + items.filter { !it.pinned }
    }

    /** The newest entry, if any (pinned or not). */
    @Synchronized
    fun latest(): ClipItem? {
        if (prune(clock())) version++
        return items.maxByOrNull { it.time }
    }

    @Synchronized
    fun setPinned(id: Long, pinned: Boolean): Boolean {
        val i = items.indexOfFirst { it.id == id }
        if (i < 0) return false
        items[i] = items[i].copy(pinned = pinned)
        // Unpinning may push the history over its size limit.
        prune(clock())
        version++
        return true
    }

    @Synchronized
    fun remove(id: Long): Boolean {
        val removed = items.removeAll { it.id == id }
        if (removed) version++
        return removed
    }

    /** Clears the history; pinned items stay unless [includePinned]. */
    @Synchronized
    fun clear(includePinned: Boolean = false) {
        if (includePinned) items.clear() else items.removeAll { !it.pinned }
        version++
    }

    @Synchronized fun size(): Int = items.size

    @Synchronized
    fun save(): String = JSON.encodeToString(ClipFile.serializer(), ClipFile(1, items.toList()))

    /** Loads saved history, keeping anything added in memory before the load finished. */
    @Synchronized
    fun load(json: String?) {
        val early = items.toList()
        items.clear()
        val f = json?.takeIf { it.isNotBlank() }?.let { runCatching { JSON.decodeFromString(ClipFile.serializer(), it) }.getOrNull() }
        if (f != null) items += f.items
        nextId = (items.maxOfOrNull { it.id } ?: 0L) + 1
        for (e in early) {
            items.removeAll { it.text == e.text }
            items += e.copy(id = nextId++)
        }
        items.sortByDescending { it.time }
        prune(clock())
        version++
    }

    /** Drops expired unpinned items and the oldest beyond [maxUnpinned]. True if anything changed. */
    private fun prune(now: Long): Boolean {
        val before = items.size
        if (expiryMs > 0) items.removeAll { !it.pinned && now - it.time > expiryMs }
        var unpinned = 0
        val it = items.iterator()
        // items are newest first
        while (it.hasNext()) {
            val c = it.next()
            if (!c.pinned && ++unpinned > maxUnpinned) it.remove()
        }
        return items.size != before
    }

    companion object {
        const val DEFAULT_MAX = 50
        const val DEFAULT_EXPIRY_MS = 60L * 60_000L
        /** Longest text kept per entry (characters). */
        const val MAX_TEXT = 20_000
        private val JSON = Json { ignoreUnknownKeys = true; encodeDefaults = true }

        /** Expiry choices offered in Settings (ms; 0 = never). */
        val EXPIRY_CHOICES = longArrayOf(15L * 60_000L, 60L * 60_000L, 24L * 60L * 60_000L, 0L)
    }
}

/** When a copied clip must not be stored (unit-tested). */
object ClipPolicy {
    /**
     * @param flaggedSensitive the clip's description carries EXTRA_IS_SENSITIVE (Android 13+), or
     *   the legacy "android.content.extra.IS_SENSITIVE" extra.
     * @param fromPasswordField the clip appeared while a password field had focus.
     * @param labelHint the clip label (some password managers label their clips).
     */
    fun skip(flaggedSensitive: Boolean, fromPasswordField: Boolean, labelHint: CharSequence? = null): Boolean {
        if (flaggedSensitive || fromPasswordField) return true
        val l = labelHint?.toString()?.lowercase() ?: return false
        return SENSITIVE_LABELS.any { it in l }
    }

    private val SENSITIVE_LABELS = listOf("password", "passcode", "otp", "one-time", "2fa", "סיסמה")
}
