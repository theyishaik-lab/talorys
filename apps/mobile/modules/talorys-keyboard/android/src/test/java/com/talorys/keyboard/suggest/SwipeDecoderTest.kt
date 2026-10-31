package com.talorys.keyboard.suggest

import com.talorys.keyboard.keyboard.FieldFlavor
import com.talorys.keyboard.keyboard.Geometry
import com.talorys.keyboard.keyboard.KeyRows
import com.talorys.keyboard.keyboard.Layouts
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

/**
 * Decodes synthetic gestures drawn over the real layouts (1080 px wide board) against the
 * bundled dictionaries. Gestures follow each word's key path with per-corner jitter, overshoot
 * and dense sampling, like a finger would.
 */
class SwipeDecoderTest {

    companion object {
        private const val W = 1080f
        private const val H = 5 * 150f
        val en: WordDictionary get() = TestData.en
        val he: WordDictionary get() = TestData.he

        fun decoderFor(rows: KeyRows): SwipeDecoder {
            val placed = Geometry.layout(rows, 0f, 0f, W, H).filter { it.first.isLetter }
            val keys = placed.associate { it.first.label[0] to Pt(it.second.centerX, it.second.centerY) }
            return SwipeDecoder(keys, placed.first().second.width, placed.first().second.height)
        }

        /** A finger-like gesture through the word's keys. */
        fun gesture(dec: SwipeDecoder, word: String, rnd: Random, jitter: Float = 0.22f, kw: Float = 108f): List<Pt> {
            val corners = dec.idealPoints(word)!!.map {
                Pt(it.x + (rnd.nextFloat() * 2 - 1) * jitter * kw, it.y + (rnd.nextFloat() * 2 - 1) * jitter * kw * 1.2f)
            }
            if (corners.size == 1) return listOf(corners[0], Pt(corners[0].x + 8, corners[0].y + 4))
            val out = ArrayList<Pt>()
            for (i in 1 until corners.size) {
                val a = corners[i - 1]; val b = corners[i]
                val steps = 12
                for (s in 0 until steps) {
                    val t = s / steps.toFloat()
                    // slight arc, as real strokes curve
                    val bow = kotlin.math.sin(t * Math.PI).toFloat() * 0.08f * kw
                    out += Pt(a.x + t * (b.x - a.x), a.y + t * (b.y - a.y) + bow)
                }
            }
            out += corners.last()
            return out
        }
    }

    private fun rate(dec: SwipeDecoder, dict: WordDictionary, words: List<String>, seed: Int, lm: LanguageModel? = null, jitter: Float = 0.22f): Pair<Int, Int> {
        val rnd = Random(seed)
        var top1 = 0; var top3 = 0
        val misses = ArrayList<String>()
        for (w in words) {
            val res = dec.decode(gesture(dec, w, rnd, jitter), dict, 5, lm).map { it.word }
            if (res.firstOrNull() == w) top1++ else misses += "$w→${res.take(3)}"
            if (w in res.take(3)) top3++
        }
        println("top1 $top1/${words.size} top3 $top3/${words.size} misses: $misses")
        return top1 to top3
    }

    private val enWords = listOf(
        "hello", "world", "keyboard", "thanks", "because", "people", "something", "tomorrow", "morning",
        "great", "would", "should", "about", "really", "where", "think", "going", "little", "never",
        "house", "water", "friend", "family", "phone", "love", "time", "good", "what", "know", "work",
        "please", "night", "today", "happy", "money", "school", "place", "right", "thing", "maybe",
    )

    private val heWords = listOf(
        "שלום", "תודה", "אני", "מה", "בית", "אתה", "היום", "מחר", "בבקשה", "אוהב", "עבודה", "משפחה",
        "חבר", "טוב", "יודע", "רוצה", "אפשר", "צריך", "עכשיו", "בסדר", "לילה", "בוקר", "כסף", "ילדים",
        "אמא", "אבא", "מים", "זמן", "שאלה", "תשובה", "מכונית", "ספר", "חושב", "אולי", "כולם", "יפה",
    )

    @Test
    fun englishGesturesDecode() {
        val dec = decoderFor(Layouts.english(FieldFlavor.TEXT, true))
        val (top1, top3) = rate(dec, en, enWords, 7, TestData.enModel())
        assertTrue("top-1 $top1/${enWords.size}", top1 >= enWords.size * 0.8)
        assertTrue("top-3 $top3/${enWords.size}", top3 >= enWords.size * 0.92)
    }

    @Test
    fun hebrewGesturesDecode() {
        val dec = decoderFor(Layouts.hebrew(FieldFlavor.TEXT, true))
        val (top1, top3) = rate(dec, he, heWords, 11, TestData.heModel())
        assertTrue("top-1 $top1/${heWords.size}", top1 >= heWords.size * 0.9)
        assertTrue("top-3 $top3/${heWords.size}", top3 >= heWords.size * 0.9)
    }

    /** The 1.2.x miss: בית decoded as בבית (same key path, ב doubled). */
    @Test
    fun hebrewBaitIsTopOne() {
        val dec = decoderFor(Layouts.hebrew(FieldFlavor.TEXT, true))
        val rnd = Random(11)
        repeat(5) {
            assertEquals("בית", dec.decode(gesture(dec, "בית", rnd), he, 5, TestData.heModel()).first().word)
        }
        assertEquals("בית", dec.decode(SwipeDecoder.resample(dec.idealPoints("בית")!!, 60), he).first().word)
    }

    /** Larger synthetic sets: frequent words of 3+ letters, drawn sloppier than the curated list. */
    @Test
    fun syntheticFrequentWords() {
        for ((name, rows, model) in listOf(
            Triple("en", Layouts.english(FieldFlavor.TEXT, true), TestData.enModel()),
            Triple("he", Layouts.hebrew(FieldFlavor.TEXT, true), TestData.heModel()),
        )) {
            val dec = decoderFor(rows)
            val dict = model.dict
            val words = (50 until 2500).map { dict.words[it] }.filter { it.length >= 3 && dec.idealPoints(it) != null }
                .shuffled(Random(3)).take(120)
            val (top1, top3) = rate(dec, dict, words, 21, model, jitter = 0.28f)
            println("$name synthetic: top1 $top1 top3 $top3 of ${words.size}")
            assertTrue("$name top-1 $top1/${words.size}", top1 >= words.size * 0.6)
            assertTrue("$name top-3 $top3/${words.size}", top3 >= words.size * 0.8)
        }
    }

    @Test
    fun previousWordDisambiguates() {
        val dec = decoderFor(Layouts.english(FieldFlavor.TEXT, true))
        val lm = TestData.enModel()
        val path = SwipeDecoder.resample(dec.idealPoints("you")!!, 60)
        assertEquals("you", dec.decode(path, en, 5, lm, prev = "thank").first().word)
        // "good" and "god" draw the same path; context picks.
        val g = SwipeDecoder.resample(dec.idealPoints("good")!!, 60)
        assertEquals("good", dec.decode(g, en, 5, lm, prev = "very").first().word)
        assertEquals("god", dec.decode(g, en, 5, lm, prev = "oh").first().word)
    }

    @Test
    fun hebrewPrefixedWordsNotInTheListDecode() {
        val dec = decoderFor(Layouts.hebrew(FieldFlavor.TEXT, true))
        val lm = TestData.heModel()
        val rnd = Random(4)
        val words = listOf("ולמחשב", "שהמשפחה", "כשהילד", "ובעבודה", "מהבית", "לחברים", "וכשהיא", "שבבית")
        var top3 = 0
        val misses = ArrayList<String>()
        for (w in words) {
            val res = dec.decode(gesture(dec, w, rnd, 0.15f), he, 5, lm).map { it.word }
            if (w in res.take(3)) top3++ else misses += "$w→${res.take(3)}"
        }
        println("prefixed: top3 $top3/${words.size} misses $misses (in list: ${words.filter { he.contains(it) }})")
        assertTrue("prefixed top-3 $top3/${words.size}: $misses", top3 >= words.size - 2)
    }

    /** Prefix chains glued to common stems, keeping only forms the word list doesn't have. */
    @Test
    fun hebrewUnlistedPrefixFormsDecode() {
        val dec = decoderFor(Layouts.hebrew(FieldFlavor.TEXT, true))
        val lm = TestData.heModel()
        val rnd = Random(9)
        // Content words (not starting with a prefix letter themselves).
        val stems = (300 until 3000).map { he.words[it] }.filter { it.length in 3..5 && it[0] !in "והבלמשכ" && dec.idealPoints(it) != null }
        val words = listOf("וכש", "ושה", "כשה", "ומה", "שב", "וב", "ול").flatMap { p -> stems.map { p + it } }
            .filter { !he.contains(it) }.shuffled(rnd).take(24)
        var top1 = 0; var top3 = 0
        val misses = ArrayList<String>()
        for (w in words) {
            val res = dec.decode(gesture(dec, w, rnd, 0.15f), he, 5, lm).map { it.word }
            if (res.firstOrNull() == w) top1++
            if (w in res.take(3)) top3++ else misses += "$w→${res.take(3)}"
        }
        println("unlisted prefixed: top1 $top1 top3 $top3/${words.size} misses $misses")
        assertTrue("unlisted prefixed top-3 $top3/${words.size}: $misses", top3 >= words.size * 0.6)
    }

    @Test
    fun learnedWordsAreSwipeCandidates() {
        val dec = decoderFor(Layouts.english(FieldFlavor.TEXT, true))
        val u = UserDictionary(null) { 1L }
        repeat(3) { u.learn("en", "talorys", null) }
        val path = SwipeDecoder.resample(dec.idealPoints("talorys")!!, 80)
        assertTrue(dec.decode(path, en, 5).none { it.word == "talorys" })
        assertEquals("talorys", dec.decode(path, en, 5, TestData.enModel(u)).first().word)
    }

    @Test
    fun apostropheWordsSwipe() {
        val dec = decoderFor(Layouts.english(FieldFlavor.TEXT, true))
        val path = SwipeDecoder.resample(dec.idealPoints("don't")!!, 60)
        assertEquals("don't", dec.decode(path, en, 5, TestData.enModel()).first().word)
    }

    @Test
    fun exactKeyPathDecodesToTheWord() {
        val dec = decoderFor(Layouts.english(FieldFlavor.TEXT, true))
        val path = dec.idealPoints("hello")!!
        assertEquals("hello", dec.decode(SwipeDecoder.resample(path, 60), en).first().word)
    }

    @Test
    fun hebrewFinalLettersUseTheirOwnKeys() {
        val dec = decoderFor(Layouts.hebrew(FieldFlavor.TEXT, true))
        val res = dec.decode(SwipeDecoder.resample(dec.idealPoints("שלום")!!, 60), he).map { it.word }
        assertEquals("שלום", res.first())
    }

    @Test
    fun tinyMovementIsNotAGesture() {
        val dec = decoderFor(Layouts.english(FieldFlavor.TEXT, true))
        assertTrue(dec.decode(listOf(Pt(100f, 300f), Pt(104f, 302f)), en).isEmpty())
    }

    @Test
    fun resampleKeepsEndpointsAndCount() {
        val r = SwipeDecoder.resample(listOf(Pt(0f, 0f), Pt(10f, 0f), Pt(10f, 10f)), 21)
        assertEquals(21, r.size)
        assertEquals(Pt(0f, 0f), r.first())
        assertEquals(10f, r.last().x, 0.01f)
        assertEquals(10f, r.last().y, 0.01f)
    }

    @Test
    fun completionsAreFrequencyOrdered() {
        val c = en.completions("hel", 3)
        assertEquals(3, c.size)
        assertTrue(c.all { it.startsWith("hel") })
        assertTrue("help" in c || "hello" in c)
    }
}
