package com.talorys.keyboard

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import androidx.core.content.edit

/** Non-secret UI preferences (keyboard feedback, language, background mode). */
class UiPrefs(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences("talorys_ui", Context.MODE_PRIVATE)

    var haptics: Boolean
        get() = prefs.getBoolean("haptics", true)
        set(v) = prefs.edit { putBoolean("haptics", v) }

    var sound: Boolean
        get() = prefs.getBoolean("sound", false)
        set(v) = prefs.edit { putBoolean("sound", v) }

    var swipe: Boolean
        get() = prefs.getBoolean("swipe", true)
        set(v) = prefs.edit { putBoolean("swipe", v) }

    var wordSuggestions: Boolean
        get() = prefs.getBoolean("word_suggestions", true)
        set(v) = prefs.edit { putBoolean("word_suggestions", v) }

    var alwaysOn: Boolean
        get() = prefs.getBoolean("always_on", false)
        set(v) = prefs.edit { putBoolean("always_on", v) }

    var language: String
        get() = prefs.getString("language", "") ?: ""
        set(v) = prefs.edit { putString("language", v) }

    /** Gboard-style autocorrect on space / punctuation (default on). */
    var autocorrect: Boolean
        get() = prefs.getBoolean("autocorrect", true)
        set(v) = prefs.edit { putBoolean("autocorrect", v) }

    /** Back up learned words to the user's Talorys agent (only used when the agent is configured). */
    var cloudBackup: Boolean
        get() = prefs.getBoolean("cloud_backup", true)
        set(v) = prefs.edit { putBoolean("cloud_backup", v) }

    /** Learn words that appear on screen via the accessibility service (default off; local only). */
    var screenLearning: Boolean
        get() = prefs.getBoolean("screen_learning", false)
        set(v) = prefs.edit { putBoolean("screen_learning", v) }

    /** Include words learned from the screen in the Talorys cloud backup (default off, separate from [cloudBackup]). */
    var screenBackup: Boolean
        get() = prefs.getBoolean("screen_backup", false)
        set(v) = prefs.edit { putBoolean("screen_backup", v) }

    /** Apps screen learning never reads (package names). Defaults to [com.talorys.keyboard.screen.ScreenPolicy.DEFAULT_EXCLUDED]. */
    var screenExcluded: List<String>
        get() = prefs.getString("screen_excluded", null)?.let { com.talorys.keyboard.screen.ScreenPolicy.parseList(it) }
            ?: com.talorys.keyboard.screen.ScreenPolicy.DEFAULT_EXCLUDED
        set(v) = prefs.edit { putString("screen_excluded", v.joinToString("\n")) }

    /** Haptic strength 0 (off) .. 5; follows the old on/off switch until set. */
    var hapticStrength: Int
        get() = if (prefs.contains("haptic_strength")) prefs.getInt("haptic_strength", 2) else if (haptics) 2 else 0
        set(v) = prefs.edit { putInt("haptic_strength", v); putBoolean("haptics", v > 0) }

    /** Use the system's KEYBOARD_TAP haptic (follows the phone's touch-feedback setting) instead of our own vibration. */
    var hapticSystem: Boolean
        get() = prefs.getBoolean("haptic_system", false)
        set(v) = prefs.edit { putBoolean("haptic_system", v) }

    var soundVolume: Float
        get() = prefs.getFloat("sound_volume", 0.5f)
        set(v) = prefs.edit { putFloat("sound_volume", v) }

    /** Height of one key row in portrait, dp. Landscape uses [LANDSCAPE_SCALE] of it. */
    var keyHeightDp: Float
        get() = prefs.getFloat("key_height_dp", DEFAULT_KEY_HEIGHT)
        set(v) = prefs.edit { putFloat("key_height_dp", v.coerceIn(MIN_KEY_HEIGHT, MAX_KEY_HEIGHT)) }

    /** "system", "light" or "dark". */
    var theme: String
        get() = prefs.getString("theme", "system") ?: "system"
        set(v) = prefs.edit { putString("theme", v) }

    /** Material You (wallpaper) colours on Android 12+. */
    var dynamicColor: Boolean
        get() = prefs.getBoolean("dynamic_color", true)
        set(v) = prefs.edit { putBoolean("dynamic_color", v) }

    var clipboardHistory: Boolean
        get() = prefs.getBoolean("clipboard_history", true)
        set(v) = prefs.edit { putBoolean("clipboard_history", v) }

    /** Unpinned clipboard items expire after this long (0 = never). */
    var clipboardExpiryMs: Long
        get() = prefs.getLong("clipboard_expiry_ms", 60L * 60_000L)
        set(v) = prefs.edit { putLong("clipboard_expiry_ms", v) }

    var emojiSuggestions: Boolean
        get() = prefs.getBoolean("emoji_suggestions", true)
        set(v) = prefs.edit { putBoolean("emoji_suggestions", v) }

    var keyPreviews: Boolean
        get() = prefs.getBoolean("key_previews", true)
        set(v) = prefs.edit { putBoolean("key_previews", v) }

    var showHints: Boolean
        get() = prefs.getBoolean("show_hints", true)
        set(v) = prefs.edit { putBoolean("show_hints", v) }

    /** 0 = off, -1 = left, 1 = right. */
    var oneHanded: Int
        get() = prefs.getInt("one_handed", 0)
        set(v) = prefs.edit { putInt("one_handed", v) }

    /** Changes to anything that needs the input view rebuilt (theme, colours). */
    val themeKey: String get() = "$theme/$dynamicColor"

    companion object {
        const val DEFAULT_KEY_HEIGHT = 56f
        const val MIN_KEY_HEIGHT = 44f
        const val MAX_KEY_HEIGHT = 76f
        const val LANDSCAPE_SCALE = 0.75f
        /** Presets offered in Settings: Compact, Normal (Gboard-like), Tall (the 1.3.0 +25% size), Extra tall. */
        val KEY_HEIGHT_PRESETS = floatArrayOf(50f, 56f, 62.5f, 70f)
    }

    var lastDictSync: Long
        get() = prefs.getLong("dict_last_sync", 0L)
        set(v) = prefs.edit { putLong("dict_last_sync", v) }

    var lastDictSyncAttempt: Long
        get() = prefs.getLong("dict_last_sync_attempt", 0L)
        set(v) = prefs.edit { putLong("dict_last_sync_attempt", v) }
}

/**
 * Latest structural screen context from the accessibility service: app label + focused field hint.
 * Process-local; never contains what the user typed.
 */
object ScreenContext {
    private data class Entry(val packageName: String, val description: String, val at: Long)

    @Volatile private var entry: Entry? = null

    fun update(packageName: String, description: String) {
        entry = Entry(packageName, description, SystemClock.elapsedRealtime())
    }

    /** The context for [packageName], if fresh (last 10 min). Context from other apps is never returned. */
    fun forPackage(packageName: String?): String? {
        val e = entry ?: return null
        if (packageName == null || e.packageName != packageName) return null
        if (SystemClock.elapsedRealtime() - e.at > 10 * 60_000L) return null
        return e.description
    }
}

/**
 * Text the user chose to insert from the chat sheet. The keyboard commits it the next time the
 * same field (package + field id) starts input, then clears it. Expires after 3 minutes.
 */
object PendingInsert {
    private data class Item(val text: String, val packageName: String, val fieldId: Int, val at: Long)

    @Volatile private var item: Item? = null

    fun set(text: String, packageName: String, fieldId: Int) {
        item = Item(text, packageName, fieldId, SystemClock.elapsedRealtime())
    }

    fun take(packageName: String?, fieldId: Int): String? = synchronized(this) {
        val i = item ?: return null
        if (SystemClock.elapsedRealtime() - i.at > 3 * 60_000L) { item = null; return null }
        if (packageName != i.packageName) return null
        // Some editors (WebViews) report no stable id; match on package alone then.
        if (i.fieldId != 0 && i.fieldId != -1 && fieldId != 0 && fieldId != -1 && i.fieldId != fieldId) return null
        item = null
        i.text
    }
}
