package com.talorys.keyboard.screen

import com.talorys.keyboard.suggest.HebrewPrefixes
import com.talorys.keyboard.suggest.LearnedWord
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/** A word seen on screen. [events] holds the distinct screens it was seen on until it is eligible. */
@Serializable
data class ScreenWord(
    val w: String,
    val lang: String,
    /** Number of distinct screens/events it was seen on. */
    val count: Int,
    val firstSeen: Long,
    val lastSeen: Long,
    val events: List<Long> = emptyList(),
    /** The user deleted it: never learned from the screen again (typing it still teaches it). */
    val deleted: Boolean? = null,
) {
    val isDeleted: Boolean get() = deleted == true
    val eligible: Boolean get() = !isDeleted && count >= ScreenWordStore.THRESHOLD
}

@Serializable
private data class ScreenFile(val schema: Int = 1, val words: List<ScreenWord> = emptyList())

/** Read-only view the language model uses (low-weight words learned from the screen). */
interface ScreenLexicon {
    fun isEligible(lang: String, word: String): Boolean
    fun eligibleWords(lang: String): List<String>
}

/**
 * Words learned from text on screen, kept apart from the personal (typed) dictionary so they never
 * reach the cloud backup unless the user turns that on separately, and can be listed and removed.
 *
 * A word counts once per distinct screen/event ([recordEvent] with a key that identifies what was on
 * screen). After [THRESHOLD] distinct sightings it becomes eligible: offered as a low-weight
 * suggestion. When the user types or accepts it, [promote] removes it here and the caller teaches it
 * to the personal dictionary at full weight. Thread-safe.
 */
class ScreenWordStore(private val file: File? = null, private val clock: () -> Long = System::currentTimeMillis) : ScreenLexicon {

    private val words = HashMap<String, ScreenWord>()
    /** Built-in dictionary check, set by the keyboard once its dictionaries are loaded. */
    @Volatile var isMainWord: ((lang: String, word: String) -> Boolean)? = null

    @Volatile var dirty = false
        private set
    @Volatile var version = 0L
        private set

    init {
        file?.takeIf { it.exists() }?.let { f ->
            runCatching { JSON.decodeFromString(ScreenFile.serializer(), f.readText()) }.getOrNull()?.words?.forEach { words[key(it.lang, it.w)] = it }
        }
    }

    private fun key(lang: String, w: String) = "$lang\u0001$w"

    /** True when [word] (or, for Hebrew, its stem after a prefix chain) is a built-in word. */
    fun isKnownMain(lang: String, word: String): Boolean {
        val f = isMainWord ?: return false
        if (f(lang, word)) return true
        if (lang == "he") return HebrewPrefixes.splits(word, minStem = 2).any { (_, stem) -> f(lang, stem) }
        return false
    }

    /**
     * Records the words seen in one screen/event. [eventKey] identifies the content (same text on the
     * same screen gives the same key, so a re-render or a re-read never counts twice).
     * Returns how many words became eligible.
     */
    @Synchronized
    fun recordEvent(eventKey: Long, tokens: Collection<ScreenToken>): Int {
        val now = clock()
        var promotedToEligible = 0
        for (t in tokens.toSet()) {
            if (isKnownMain(t.lang, t.word)) continue
            val k = key(t.lang, canonical(t))
            val old = words[k]
            if (old != null && old.isDeleted) continue
            val w = k.substringAfter('\u0001')
            val next = when {
                old == null -> ScreenWord(w, t.lang, 1, now, now, listOf(eventKey))
                eventKey in old.events -> continue
                else -> {
                    val c = old.count + 1
                    // Keep the event keys only while they matter for the threshold.
                    val ev = if (c >= THRESHOLD) listOf(eventKey) else (old.events + eventKey).takeLast(THRESHOLD)
                    old.copy(count = c, lastSeen = now, events = ev)
                }
            }
            if (next.eligible && (old == null || !old.eligible)) promotedToEligible++
            words[k] = next
            if (t.lang == "he" && old == null) absorbPrefixedForms(t.lang, w)
        }
        if (tokens.isNotEmpty()) changed()
        if (words.size > MAX_WORDS) trim(now)
        return promotedToEligible
    }

    /**
     * Hebrew: "לטלוריס" counts toward "טלוריס" when the bare stem is already tracked. A prefix is
     * only stripped then, since ב/ל/מ/ה/ו/כ/ש are also ordinary first letters ("בית", "לחם").
     */
    private fun canonical(t: ScreenToken): String {
        if (t.lang != "he") return t.word
        if (words.containsKey(key(t.lang, t.word))) return t.word
        for ((_, stem) in HebrewPrefixes.splits(t.word, minStem = ScreenTokenizer.MIN_LEN)) {
            val s = words[key(t.lang, stem)]
            if (s != null && !s.isDeleted) return stem
        }
        return t.word
    }

    /** A bare Hebrew stem was just seen: fold earlier prefixed sightings ("והטלוריס") into it. */
    private fun absorbPrefixedForms(lang: String, stem: String) {
        val k = key(lang, stem)
        var base = words[k] ?: return
        val absorbed = ArrayList<String>()
        for ((ok, ow) in words) {
            if (ok == k || ow.lang != lang || ow.isDeleted || !ow.w.endsWith(stem)) continue
            val pre = ow.w.substring(0, ow.w.length - stem.length)
            if (pre in HebrewPrefixes.all) {
                val ev = (base.events + ow.events).distinct()
                base = base.copy(count = base.count + ow.count, firstSeen = minOf(base.firstSeen, ow.firstSeen),
                    lastSeen = maxOf(base.lastSeen, ow.lastSeen), events = ev.takeLast(THRESHOLD))
                absorbed += ok
            }
        }
        absorbed.forEach { words.remove(it) }
        words[k] = base
    }

    @Synchronized override fun isEligible(lang: String, word: String): Boolean = words[key(lang, word)]?.eligible == true

    @Synchronized override fun eligibleWords(lang: String): List<String> =
        words.values.filter { it.lang == lang && it.eligible }.map { it.w }

    /** Words seen at least [THRESHOLD] times (what the settings screen lists), newest first, filtered by [query]. */
    @Synchronized fun learned(query: String = ""): List<ScreenWord> {
        val q = query.trim().lowercase()
        return words.values.filter { it.eligible && (q.isEmpty() || it.w.contains(q)) }.sortedByDescending { it.lastSeen }
    }

    /** Words still below the threshold (not offered yet). */
    @Synchronized fun pendingCount(): Int = words.values.count { !it.isDeleted && !it.eligible }

    /**
     * The user typed or accepted [word]: if it came from the screen, it leaves this store (the
     * caller teaches it to the personal dictionary). Returns true when it was an eligible screen word.
     */
    @Synchronized
    fun promote(lang: String, word: String): Boolean {
        val k = key(lang, word)
        val old = words[k] ?: return false
        if (old.isDeleted) return false
        words.remove(k)
        changed()
        return old.eligible
    }

    /** Deletes one word; it is remembered as deleted so the screen never teaches it again. */
    @Synchronized
    fun remove(lang: String, word: String): Boolean {
        val k = key(lang, word)
        val old = words[k] ?: return false
        if (old.isDeleted) return false
        words[k] = old.copy(deleted = true, lastSeen = maxOf(clock(), old.lastSeen), events = emptyList())
        changed()
        return true
    }

    /** Forgets every screen word (eligible and pending). Deleted markers are kept for the backup. */
    @Synchronized
    fun clearAll() {
        val now = clock()
        for ((k, w) in words.entries.toList()) {
            if (w.isDeleted) continue
            if (w.eligible) words[k] = w.copy(deleted = true, lastSeen = maxOf(now, w.lastSeen), events = emptyList())
            else words.remove(k)
        }
        changed()
    }

    /** Drops screen words that turned out to be built-in words (called when the dictionaries load). */
    @Synchronized
    fun pruneKnown(): Int {
        if (isMainWord == null) return 0
        val drop = words.entries.filter { !it.value.isDeleted && isKnownMain(it.value.lang, it.value.w) }.map { it.key }
        drop.forEach { words.remove(it) }
        if (drop.isNotEmpty()) changed()
        return drop.size
    }

    /** Eligible words and deletions in the backup's word format (count = sightings). */
    @Synchronized
    fun exportForBackup(): List<LearnedWord> = words.values.filter { it.eligible || it.isDeleted }
        .map { LearnedWord(it.w, it.lang, it.count.toLong(), it.lastSeen, if (it.isDeleted) true else null) }

    /** Merges screen words from the backup: max count / max time, a deletion wins when newer or equal. */
    @Synchronized
    fun mergeBackup(remote: List<LearnedWord>?) {
        if (remote.isNullOrEmpty()) return
        for (r in remote) {
            if (r.lang != "he" && r.lang != "en") continue
            val k = key(r.lang, r.w)
            val old = words[k]
            words[k] = when {
                old == null -> ScreenWord(r.w, r.lang, r.count.toInt(), r.lastUsed, r.lastUsed, deleted = if (r.isDeleted) true else null)
                r.isDeleted && r.lastUsed >= old.lastSeen -> old.copy(deleted = true, lastSeen = r.lastUsed, events = emptyList())
                old.isDeleted && old.lastSeen >= r.lastUsed -> old
                else -> old.copy(count = maxOf(old.count, r.count.toInt()), lastSeen = maxOf(old.lastSeen, r.lastUsed), deleted = null)
            }
        }
        changed()
    }

    /** Writes to disk if changed. Call off the main thread. */
    fun flush() {
        val f = file ?: return
        val text: String
        synchronized(this) {
            if (!dirty) return
            text = JSON.encodeToString(ScreenFile.serializer(), ScreenFile(1, words.values.toList()))
            dirty = false
        }
        runCatching {
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        }
    }

    private fun changed() { dirty = true; version++ }

    /** Bounded: pending words not seen for [PENDING_TTL_MS] go first, then the least seen. */
    private fun trim(now: Long) {
        words.entries.removeIf { !it.value.isDeleted && !it.value.eligible && now - it.value.lastSeen > PENDING_TTL_MS }
        if (words.size <= MAX_WORDS) return
        val drop = words.entries.filter { !it.value.isDeleted }.sortedWith(compareBy({ it.value.count }, { it.value.lastSeen }))
            .take(words.size - MAX_WORDS).map { it.key }
        drop.forEach { words.remove(it) }
    }

    companion object {
        /** Distinct screens a word must appear on before it is offered. */
        const val THRESHOLD = 3
        const val MAX_WORDS = 5000
        const val PENDING_TTL_MS = 30L * 86_400_000L
        private val JSON = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
    }
}
