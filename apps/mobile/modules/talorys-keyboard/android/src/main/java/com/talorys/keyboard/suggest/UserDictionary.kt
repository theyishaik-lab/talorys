package com.talorys.keyboard.suggest

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.io.File

/** One learned word. [deleted] marks a tombstone (kept so a delete reaches the cloud backup). */
@Serializable
data class LearnedWord(val w: String, val lang: String, val count: Long, val lastUsed: Long, val deleted: Boolean? = null) {
    val isDeleted: Boolean get() = deleted == true
}

@Serializable
data class LearnedBigram(val a: String, val b: String, val lang: String, val count: Long, val lastUsed: Long, val deleted: Boolean? = null) {
    val isDeleted: Boolean get() = deleted == true
}

/** The on-disk and backup format (GET/PUT {agent}/api/keyboard/dictionary). */
@Serializable
data class DictionaryPayload(
    val schema: Int = 1,
    val updatedAt: Long = 0,
    val words: List<LearnedWord> = emptyList(),
    val bigrams: List<LearnedBigram> = emptyList(),
    /**
     * Words learned from the screen (1.4.1+). Only sent when "Include screen words in the backup" is
     * on; null (omitted) otherwise, so they never leave the device by default.
     */
    val screenWords: List<LearnedWord>? = null,
) {
    fun toJson(): String = JSON.encodeToString(serializer(), this)

    companion object {
        val JSON = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = true }
        fun fromJson(text: String?): DictionaryPayload? =
            if (text.isNullOrBlank()) null else runCatching { JSON.decodeFromString(serializer(), text) }.getOrNull()
    }
}

/**
 * Merge rules for the backup: union by key (w+lang, a+b+lang), max count, max lastUsed. A deleted
 * entry wins when its lastUsed is >= the other side's.
 */
object DictionaryMerge {

    fun mergeWord(x: LearnedWord, y: LearnedWord): LearnedWord {
        val deleted = when {
            x.isDeleted && y.isDeleted -> true
            x.isDeleted -> x.lastUsed >= y.lastUsed
            y.isDeleted -> y.lastUsed >= x.lastUsed
            else -> false
        }
        return LearnedWord(x.w, x.lang, maxOf(x.count, y.count), maxOf(x.lastUsed, y.lastUsed), if (deleted) true else null)
    }

    fun mergeBigram(x: LearnedBigram, y: LearnedBigram): LearnedBigram {
        val deleted = when {
            x.isDeleted && y.isDeleted -> true
            x.isDeleted -> x.lastUsed >= y.lastUsed
            y.isDeleted -> y.lastUsed >= x.lastUsed
            else -> false
        }
        return LearnedBigram(x.a, x.b, x.lang, maxOf(x.count, y.count), maxOf(x.lastUsed, y.lastUsed), if (deleted) true else null)
    }

    fun merge(local: DictionaryPayload, remote: DictionaryPayload?, now: Long): DictionaryPayload {
        if (remote == null) return local.copy(updatedAt = now)
        val words = LinkedHashMap<String, LearnedWord>()
        for (w in local.words + remote.words) {
            val k = wordKey(w.lang, w.w)
            words[k] = words[k]?.let { mergeWord(it, w) } ?: w
        }
        val bigrams = LinkedHashMap<String, LearnedBigram>()
        for (b in local.bigrams + remote.bigrams) {
            val k = bigramKey(b.lang, b.a, b.b)
            bigrams[k] = bigrams[k]?.let { mergeBigram(it, b) } ?: b
        }
        return DictionaryPayload(1, now, words.values.toList(), bigrams.values.toList())
    }

    fun wordKey(lang: String, w: String) = "$lang\u0001$w"
    fun bigramKey(lang: String, a: String, b: String) = "$lang\u0001$a\u0001$b"
}

/**
 * The personal dictionary: words the user typed or accepted, and the pairs they typed them in.
 * Thread-safe. Lives in app-private storage; it is never fed from password fields.
 *
 * A word that is not in the built-in dictionary becomes "known" (suggested, protected from
 * autocorrect) once typed twice, or at once when explicitly chosen (the literal word in the
 * strip, or reverting an autocorrection), which adds [EXPLICIT_WEIGHT].
 */
class UserDictionary(private val file: File? = null, private val clock: () -> Long = System::currentTimeMillis) {

    private val words = HashMap<String, LearnedWord>()
    private val bigrams = HashMap<String, LearnedBigram>()
    /** lang+prev -> next words, for prediction. */
    private val successors = HashMap<String, MutableSet<String>>()

    @Volatile var dirty = false
        private set
    /** Changes since the last successful backup. */
    @Volatile var unsynced = false
        private set

    init { file?.let { f -> if (f.exists()) DictionaryPayload.fromJson(runCatching { f.readText() }.getOrNull())?.let { load(it) } } }

    @Synchronized
    private fun load(p: DictionaryPayload) {
        words.clear(); bigrams.clear(); successors.clear()
        for (w in p.words) words[DictionaryMerge.wordKey(w.lang, w.w)] = w
        for (b in p.bigrams) {
            bigrams[DictionaryMerge.bigramKey(b.lang, b.a, b.b)] = b
            if (!b.isDeleted) successors.getOrPut(succKey(b.lang, b.a)) { HashSet() } += b.b
        }
    }

    /** Records that [word] was committed after [prev] (null at a boundary). */
    @Synchronized
    fun learn(lang: String, word: String, prev: String?, weight: Int = 1) {
        if (!learnable(word)) return
        val now = clock()
        val k = DictionaryMerge.wordKey(lang, word)
        val old = words[k]
        words[k] = if (old == null || old.isDeleted) LearnedWord(word, lang, weight.toLong(), now)
        else old.copy(count = old.count + weight, lastUsed = now)
        if (prev != null && learnable(prev)) {
            val bk = DictionaryMerge.bigramKey(lang, prev, word)
            val ob = bigrams[bk]
            bigrams[bk] = if (ob == null || ob.isDeleted) LearnedBigram(prev, word, lang, 1, now)
            else ob.copy(count = ob.count + 1, lastUsed = now)
            successors.getOrPut(succKey(lang, prev)) { HashSet() } += word
        }
        changed()
        if (words.size > MAX_WORDS * 2 || bigrams.size > MAX_BIGRAMS * 2) trim()
    }

    @Synchronized fun count(lang: String, word: String): Long =
        words[DictionaryMerge.wordKey(lang, word)]?.takeIf { !it.isDeleted }?.count ?: 0

    fun isKnown(lang: String, word: String): Boolean = count(lang, word) >= KNOWN_COUNT

    /** Learned words that count as known, for candidate generation. */
    @Synchronized fun knownWords(lang: String): List<LearnedWord> =
        words.values.filter { it.lang == lang && !it.isDeleted && it.count >= KNOWN_COUNT }

    /** Learned next words after [prev] with their counts, most frequent first. */
    @Synchronized fun nextWords(lang: String, prev: String): List<Pair<String, Long>> {
        val set = successors[succKey(lang, prev)] ?: return emptyList()
        return set.mapNotNull { b -> bigrams[DictionaryMerge.bigramKey(lang, prev, b)]?.takeIf { !it.isDeleted }?.let { b to it.count } }
            .sortedByDescending { it.second }
    }

    @Synchronized fun bigramCount(lang: String, prev: String, word: String): Long =
        bigrams[DictionaryMerge.bigramKey(lang, prev, word)]?.takeIf { !it.isDeleted }?.count ?: 0

    /** Forgets a learned word and every pair containing it (as tombstones). True if it was learned. */
    @Synchronized
    fun remove(lang: String, word: String): Boolean {
        val now = clock()
        val k = DictionaryMerge.wordKey(lang, word)
        val old = words[k]
        var any = false
        if (old != null && !old.isDeleted) { words[k] = old.copy(deleted = true, lastUsed = maxOf(now, old.lastUsed)); any = true }
        for ((bk, b) in bigrams) if (b.lang == lang && !b.isDeleted && (b.a == word || b.b == word)) {
            bigrams[bk] = b.copy(deleted = true, lastUsed = maxOf(now, b.lastUsed)); any = true
        }
        successors.remove(succKey(lang, word))
        successors.values.forEach { it.remove(word) }
        if (any) changed()
        return any
    }

    /** Forgets everything; tombstones are kept so the backup forgets it too. */
    @Synchronized
    fun clearAll() {
        val now = clock()
        for ((k, w) in words) if (!w.isDeleted) words[k] = w.copy(deleted = true, lastUsed = maxOf(now, w.lastUsed))
        for ((k, b) in bigrams) if (!b.isDeleted) bigrams[k] = b.copy(deleted = true, lastUsed = maxOf(now, b.lastUsed))
        successors.clear()
        changed()
    }

    @Synchronized fun learnedWordCount(): Int = words.values.count { !it.isDeleted }

    @Synchronized fun snapshot(): DictionaryPayload =
        DictionaryPayload(1, clock(), words.values.toList(), bigrams.values.toList())

    /** Merges [remote] into the local state (backup sync) and returns what to upload. */
    @Synchronized
    fun mergeRemote(remote: DictionaryPayload?): DictionaryPayload {
        val merged = DictionaryMerge.merge(snapshot(), remote, clock())
        load(merged)
        trim()
        dirty = true
        version++
        return snapshot()
    }

    @Synchronized fun markSynced(snapshotTime: Long) {
        // Anything learned after the snapshot was taken still needs a sync.
        val newer = words.values.any { it.lastUsed > snapshotTime } || bigrams.values.any { it.lastUsed > snapshotTime }
        unsynced = newer
    }

    /** Writes to disk if changed. Call off the main thread. */
    fun flush() {
        val f = file ?: return
        val text: String
        synchronized(this) {
            if (!dirty) return
            text = snapshot().toJson()
            dirty = false
        }
        runCatching {
            val tmp = File(f.parentFile, f.name + ".tmp")
            tmp.writeText(text)
            if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
        }
    }

    /** Bumped on every change (cheap cache key for callers). */
    @Volatile var version = 0L
        private set

    private fun changed() { dirty = true; unsynced = true; version++ }

    /** Keeps the store bounded: drops the least used entries and old tombstones. */
    @Synchronized
    private fun trim() {
        val now = clock()
        words.entries.removeIf { it.value.isDeleted && now - it.value.lastUsed > TOMBSTONE_TTL }
        bigrams.entries.removeIf { it.value.isDeleted && now - it.value.lastUsed > TOMBSTONE_TTL }
        fun <T> keepTop(map: HashMap<String, T>, max: Int, score: (T) -> Double) {
            if (map.size <= max) return
            val drop = map.entries.sortedBy { score(it.value) }.take(map.size - max).map { it.key }
            drop.forEach { map.remove(it) }
        }
        keepTop(words, MAX_WORDS) { it.count + it.lastUsed / DAY_MS / 7.0 }
        keepTop(bigrams, MAX_BIGRAMS) { it.count + it.lastUsed / DAY_MS / 7.0 }
        successors.clear()
        for (b in bigrams.values) if (!b.isDeleted) successors.getOrPut(succKey(b.lang, b.a)) { HashSet() } += b.b
    }

    private fun succKey(lang: String, a: String) = "$lang\u0001$a"

    companion object {
        const val KNOWN_COUNT = 2L
        const val EXPLICIT_WEIGHT = 2
        const val MAX_WORDS = 8000
        const val MAX_BIGRAMS = 25000
        private const val DAY_MS = 86_400_000.0
        private const val TOMBSTONE_TTL = 180L * 86_400_000L

        /** Only real words: letters (and an inner apostrophe), no digits, sane length. */
        fun learnable(w: String): Boolean =
            w.length in 1..32 && w.first().isLetter() && w.last().isLetter() && w.all { it.isLetter() || it == '\'' }
    }
}
