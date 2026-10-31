package com.talorys.keyboard.suggest

import com.talorys.keyboard.keyboard.FieldFlavor
import com.talorys.keyboard.keyboard.Geometry
import com.talorys.keyboard.keyboard.KeyRows
import com.talorys.keyboard.keyboard.Layouts
import java.io.File

/** Bundled dictionaries and keyboard geometry shared by the engine tests (loaded once). */
object TestData {
    const val W = 1080f
    const val H = 5 * 150f

    private fun asset(name: String): File =
        listOf(File("src/main/assets/dict/$name"), File("app/src/main/assets/dict/$name")).first { it.exists() }

    val en: WordDictionary by lazy { asset("en.txt").reader().use { WordDictionary.load(it) } }
    val he: WordDictionary by lazy { asset("he.txt").reader().use { WordDictionary.load(it) } }
    val enPairs: Bigrams by lazy { asset("en.bigrams.txt").reader().use { Bigrams.load(it) } }
    val hePairs: Bigrams by lazy { asset("he.bigrams.txt").reader().use { Bigrams.load(it) } }

    fun keys(rows: KeyRows): Pair<Map<Char, Pt>, Float> {
        val placed = Geometry.layout(rows, 0f, 0f, W, H).filter { it.first.isLetter }
        return placed.associate { it.first.label[0] to Pt(it.second.centerX, it.second.centerY) } to placed.first().second.width
    }

    val enKeys by lazy { keys(Layouts.english(FieldFlavor.TEXT, true)) }
    val heKeys by lazy { keys(Layouts.hebrew(FieldFlavor.TEXT, true)) }

    fun enModel(user: UserDictionary? = null) = LanguageModel(en, enPairs, user, "en")
    fun heModel(user: UserDictionary? = null) = LanguageModel(he, hePairs, user, "he")
    fun enSuggester(user: UserDictionary? = null) = Suggester(enModel(user), KeyProximity(enKeys.first, enKeys.second))
    fun heSuggester(user: UserDictionary? = null) = Suggester(heModel(user), KeyProximity(heKeys.first, heKeys.second))
}
