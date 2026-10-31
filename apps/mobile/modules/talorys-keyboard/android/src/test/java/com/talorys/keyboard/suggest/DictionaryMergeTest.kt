package com.talorys.keyboard.suggest

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DictionaryMergeTest {

    private fun w(word: String, count: Long, last: Long, deleted: Boolean = false, lang: String = "en") =
        LearnedWord(word, lang, count, last, if (deleted) true else null)

    @Test fun unionTakesMaxCountAndLastUsed() {
        val local = DictionaryPayload(1, 1, listOf(w("a", 5, 100), w("b", 1, 10)), emptyList())
        val remote = DictionaryPayload(1, 2, listOf(w("a", 3, 200), w("c", 2, 50), w("a", 9, 1, lang = "he")), emptyList())
        val m = DictionaryMerge.merge(local, remote, 999)
        assertEquals(4, m.words.size)
        val a = m.words.single { it.w == "a" && it.lang == "en" }
        assertEquals(5L, a.count); assertEquals(200L, a.lastUsed); assertFalse(a.isDeleted)
        assertEquals(9L, m.words.single { it.w == "a" && it.lang == "he" }.count)
        assertEquals(999L, m.updatedAt)
    }

    @Test fun tombstoneWinsWhenNotOlder() {
        assertTrue(DictionaryMerge.mergeWord(w("a", 5, 100), w("a", 2, 100, deleted = true)).isDeleted)
        assertTrue(DictionaryMerge.mergeWord(w("a", 2, 150, deleted = true), w("a", 5, 100)).isDeleted)
        // Used again after the delete: alive.
        val alive = DictionaryMerge.mergeWord(w("a", 2, 100, deleted = true), w("a", 1, 101))
        assertFalse(alive.isDeleted)
        assertEquals(2L, alive.count); assertEquals(101L, alive.lastUsed)
        assertTrue(DictionaryMerge.mergeWord(w("a", 1, 1, true), w("a", 1, 9, true)).isDeleted)
    }

    @Test fun bigramsMergeTheSameWay() {
        val x = LearnedBigram("good", "morning", "en", 4, 10)
        val y = LearnedBigram("good", "morning", "en", 2, 20, deleted = true)
        val other = LearnedBigram("good", "night", "en", 1, 5)
        val m = DictionaryMerge.merge(DictionaryPayload(bigrams = listOf(x)), DictionaryPayload(bigrams = listOf(y, other)), 30)
        assertEquals(2, m.bigrams.size)
        val gm = m.bigrams.single { it.b == "morning" }
        assertTrue(gm.isDeleted); assertEquals(4L, gm.count); assertEquals(20L, gm.lastUsed)
    }

    @Test fun nothingRemoteKeepsLocal() {
        val local = DictionaryPayload(1, 1, listOf(w("a", 1, 1)), emptyList())
        assertEquals(local.words, DictionaryMerge.merge(local, null, 5).words)
        assertNull(DictionaryPayload.fromJson(""))
        assertNull(DictionaryPayload.fromJson("not json"))
    }

    @Test fun jsonMatchesTheServerContract() {
        val p = DictionaryPayload(1, 42, listOf(w("hi", 2, 7), w("old", 1, 8, deleted = true)),
            listOf(LearnedBigram("hi", "there", "en", 1, 7)))
        val json = p.toJson()
        assertTrue(json, json.contains("\"schema\":1") && json.contains("\"updatedAt\":42"))
        assertTrue(json, json.contains("{\"w\":\"hi\",\"lang\":\"en\",\"count\":2,\"lastUsed\":7}"))
        assertTrue(json, json.contains("\"deleted\":true"))
        assertTrue(json, json.contains("{\"a\":\"hi\",\"b\":\"there\",\"lang\":\"en\",\"count\":1,\"lastUsed\":7}"))
        assertEquals(p, DictionaryPayload.fromJson(json))
        // unknown fields from the server are ignored
        assertEquals(1, DictionaryPayload.fromJson("{\"schema\":1,\"updatedAt\":1,\"words\":[],\"bigrams\":[],\"x\":1}")!!.schema)
    }

    @Test fun userDictionaryMergeAppliesRemoteDeletes() {
        var now = 100L
        val u = UserDictionary(null) { now }
        repeat(2) { u.learn("en", "zap", null) }
        now = 200
        val remote = DictionaryPayload(1, 150, listOf(w("zap", 1, 150, deleted = true), w("zip", 3, 120)), emptyList())
        val up = u.mergeRemote(remote)
        assertFalse(u.isKnown("en", "zap"))
        assertTrue(u.isKnown("en", "zip"))
        assertTrue(up.words.single { it.w == "zap" }.isDeleted)
    }
}
