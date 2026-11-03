package com.talorys.keyboard

import android.app.role.RoleManager
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import com.google.android.material.color.DynamicColors
import com.talorys.keyboard.clip.ClipboardHistory
import com.talorys.keyboard.clip.ClipboardStore
import com.talorys.keyboard.screen.ScreenPolicy
import com.talorys.keyboard.screen.ScreenWordLearner

/**
 * Everything the app's React Native "Keyboard" settings screen reads and writes, without any Expo
 * types (so it is unit-testable). Preferences are the keyboard's own SharedPreferences ([UiPrefs]),
 * so the IME, the accessibility service and the companion read every change live.
 */
object KeyboardBridge {

    /** Keys accepted by [setPreferences], with the JS type each one takes. */
    val PREFERENCE_KEYS = listOf(
        "keyHeightDp", "theme", "dynamicColor", "language", "oneHanded",
        "wordSuggestions", "autocorrect", "emojiSuggestions", "swipe", "keyPreviews", "showHints",
        "hapticStrength", "hapticSystem", "sound", "soundVolume",
        "clipboardHistory", "clipboardExpiryMs",
        "cloudBackup", "screenLearning", "screenBackup", "alwaysOn",
    )

    fun preferences(context: Context): Map<String, Any?> {
        val p = UiPrefs(context)
        return mapOf(
            "keyHeightDp" to p.keyHeightDp.toDouble(),
            "theme" to p.theme,
            "dynamicColor" to p.dynamicColor,
            "language" to p.language,
            "oneHanded" to p.oneHanded,
            "wordSuggestions" to p.wordSuggestions,
            "autocorrect" to p.autocorrect,
            "emojiSuggestions" to p.emojiSuggestions,
            "swipe" to p.swipe,
            "keyPreviews" to p.keyPreviews,
            "showHints" to p.showHints,
            "hapticStrength" to p.hapticStrength,
            "hapticSystem" to p.hapticSystem,
            "sound" to p.sound,
            "soundVolume" to p.soundVolume.toDouble(),
            "clipboardHistory" to p.clipboardHistory,
            "clipboardExpiryMs" to p.clipboardExpiryMs.toDouble(),
            "cloudBackup" to p.cloudBackup,
            "screenLearning" to p.screenLearning,
            "screenBackup" to p.screenBackup,
            "alwaysOn" to p.alwaysOn,
        )
    }

    /** Fixed choices the screen offers (from the keyboard itself, so the two never disagree). */
    fun constants(): Map<String, Any?> = mapOf(
        "keyHeightPresets" to UiPrefs.KEY_HEIGHT_PRESETS.map { it.toDouble() },
        "minKeyHeight" to UiPrefs.MIN_KEY_HEIGHT.toDouble(),
        "maxKeyHeight" to UiPrefs.MAX_KEY_HEIGHT.toDouble(),
        "defaultKeyHeight" to UiPrefs.DEFAULT_KEY_HEIGHT.toDouble(),
        "clipboardExpiryChoices" to ClipboardStore.EXPIRY_CHOICES.map { it.toDouble() },
        "defaultExcludedApps" to ScreenPolicy.DEFAULT_EXCLUDED,
        "dynamicColorAvailable" to DynamicColors.isDynamicColorAvailable(),
    )

    /**
     * Applies the known keys of [values] (unknown keys and wrong types are ignored) and runs the
     * side effects the old settings screen ran. Returns the preferences afterwards.
     */
    fun setPreferences(context: Context, values: Map<String, Any?>): Map<String, Any?> {
        val p = UiPrefs(context)
        var clipChanged = false
        for ((key, v) in values) {
            when (key) {
                "keyHeightDp" -> num(v)?.let { p.keyHeightDp = it.toFloat() }
                "theme" -> (v as? String)?.takeIf { it in THEMES }?.let { p.theme = it }
                "dynamicColor" -> bool(v)?.let { p.dynamicColor = it }
                "language" -> (v as? String)?.takeIf { it in LANGUAGES }?.let { p.language = it }
                "oneHanded" -> num(v)?.let { p.oneHanded = it.toInt().coerceIn(-1, 1) }
                "wordSuggestions" -> bool(v)?.let { p.wordSuggestions = it }
                "autocorrect" -> bool(v)?.let { p.autocorrect = it }
                "emojiSuggestions" -> bool(v)?.let { p.emojiSuggestions = it }
                "swipe" -> bool(v)?.let { p.swipe = it }
                "keyPreviews" -> bool(v)?.let { p.keyPreviews = it }
                "showHints" -> bool(v)?.let { p.showHints = it }
                "hapticStrength" -> num(v)?.let { p.hapticStrength = it.toInt().coerceIn(0, 5) }
                "hapticSystem" -> bool(v)?.let { p.hapticSystem = it }
                "sound" -> bool(v)?.let { p.sound = it }
                "soundVolume" -> num(v)?.let { p.soundVolume = it.toFloat().coerceIn(0f, 1f) }
                "clipboardHistory" -> bool(v)?.let { p.clipboardHistory = it; clipChanged = true }
                "clipboardExpiryMs" -> num(v)?.toLong()?.takeIf { it in ClipboardStore.EXPIRY_CHOICES }?.let { p.clipboardExpiryMs = it; clipChanged = true }
                "cloudBackup" -> bool(v)?.let { on ->
                    p.cloudBackup = on
                    if (on) DictionarySync.syncNow(context)
                }
                "screenLearning" -> bool(v)?.let { p.screenLearning = it }
                "screenBackup" -> bool(v)?.let { p.screenBackup = it }
                "alwaysOn" -> bool(v)?.let { on ->
                    p.alwaysOn = on
                    if (on) CompanionService.startForegroundMode(context) else CompanionService.stopForegroundMode(context)
                }
            }
        }
        if (clipChanged) ClipboardHistory.get(context).configure(p.clipboardHistory, p.clipboardExpiryMs)
        return preferences(context)
    }

    // ---- status (setup checklist) ----

    fun status(context: Context): Map<String, Any?> {
        val client = AgentClient.get(context)
        return mapOf(
            "keyboardEnabled" to isKeyboardEnabled(context),
            "keyboardSelected" to isKeyboardSelected(context),
            "accessibilityEnabled" to isAccessibilityEnabled(context),
            "defaultAssistant" to isDefaultAssistant(context),
            "signedIn" to client.isConfigured,
            "credentialsEncrypted" to client.isEncrypted,
        )
    }

    fun imeComponent(context: Context) = ComponentName(context, TalorysInputMethodService::class.java)

    fun isKeyboardEnabled(context: Context): Boolean = runCatching {
        context.getSystemService(InputMethodManager::class.java).enabledInputMethodList.any { it.component == imeComponent(context) }
    }.getOrDefault(false)

    fun isKeyboardSelected(context: Context): Boolean {
        val id = Settings.Secure.getString(context.contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD) ?: return false
        return ComponentName.unflattenFromString(id) == imeComponent(context)
    }

    fun isAccessibilityEnabled(context: Context): Boolean {
        val list = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val mine = ComponentName(context, TalorysAccessibilityService::class.java)
        return list.split(':').any { ComponentName.unflattenFromString(it) == mine }
    }

    fun isDefaultAssistant(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val rm = context.getSystemService(RoleManager::class.java)
            if (rm != null && rm.isRoleAvailable(RoleManager.ROLE_ASSISTANT)) return rm.isRoleHeld(RoleManager.ROLE_ASSISTANT)
        }
        val assistant = Settings.Secure.getString(context.contentResolver, "assistant") ?: return false
        return ComponentName.unflattenFromString(assistant)?.packageName == context.packageName
    }

    // ---- learned words (typed) + backup ----

    fun dictionaryStatus(context: Context): Map<String, Any?> {
        val p = UiPrefs(context)
        return mapOf(
            "learnedWords" to LearnedWords.get(context).learnedWordCount(),
            "lastSync" to p.lastDictSync.toDouble(),
            "backupEnabled" to p.cloudBackup,
            "signedIn" to AgentClient.get(context).isConfigured,
        )
    }

    fun clearLearnedWords(context: Context) {
        val store = LearnedWords.get(context)
        store.clearAll()
        store.flush()
        // Push the tombstones so the backup forgets them too.
        DictionarySync.syncNow(context)
    }

    // ---- words learned from the screen ----

    fun screenWords(context: Context, query: String, limit: Int = 500): Map<String, Any?> {
        val store = ScreenWordLearner.store(context)
        val all = store.learned(query)
        return mapOf(
            "words" to all.take(limit).map { mapOf("word" to it.w, "lang" to it.lang, "count" to it.count, "lastSeen" to it.lastSeen.toDouble()) },
            "total" to store.learned().size,
            "matching" to all.size,
            "pending" to store.pendingCount(),
        )
    }

    fun deleteScreenWord(context: Context, lang: String, word: String): Boolean {
        val store = ScreenWordLearner.store(context)
        return store.remove(lang, word).also { if (it) store.flush() }
    }

    fun clearScreenWords(context: Context) {
        val store = ScreenWordLearner.store(context)
        store.clearAll()
        store.flush()
    }

    fun excludedApps(context: Context): List<String> = UiPrefs(context).screenExcluded

    /** Saves the excluded-apps list (invalid package names are dropped); null restores the defaults. */
    fun setExcludedApps(context: Context, apps: List<String>?): List<String> {
        val p = UiPrefs(context)
        p.screenExcluded = apps?.let { ScreenPolicy.parseList(it.joinToString("\n")) } ?: ScreenPolicy.DEFAULT_EXCLUDED
        ScreenWordLearner.invalidateExcluded()
        return p.screenExcluded
    }

    // ---- clipboard history ----

    fun clipboard(context: Context): List<Map<String, Any?>> =
        ClipboardHistory.get(context).store.list().map {
            mapOf("id" to it.id.toDouble(), "text" to it.text, "time" to it.time.toDouble(), "pinned" to it.pinned)
        }

    fun deleteClip(context: Context, id: Long): Boolean {
        val h = ClipboardHistory.get(context)
        return h.store.remove(id).also { if (it) h.persist() }
    }

    fun pinClip(context: Context, id: Long, pinned: Boolean): Boolean {
        val h = ClipboardHistory.get(context)
        return h.store.setPinned(id, pinned).also { if (it) h.persist() }
    }

    fun clearClipboard(context: Context, includePinned: Boolean) {
        val h = ClipboardHistory.get(context)
        h.store.clear(includePinned)
        h.persist()
    }

    private val THEMES = setOf("system", "light", "dark")
    private val LANGUAGES = setOf("", "en", "he")

    private fun bool(v: Any?): Boolean? = v as? Boolean
    private fun num(v: Any?): Double? = (v as? Number)?.toDouble()?.takeIf { !it.isNaN() && !it.isInfinite() }
}
