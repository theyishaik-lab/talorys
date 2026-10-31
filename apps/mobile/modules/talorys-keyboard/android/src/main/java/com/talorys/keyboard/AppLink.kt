package com.talorys.keyboard

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log

/**
 * The keyboard lives inside the Talorys app (dev.talorys.app) since 0.4.0: its settings are the
 * React Native screen at talorys://settings/keyboard, and signing in happens in the app itself.
 */
object AppLink {
    private const val TAG = "TalorysAppLink"
    const val SCHEME = "talorys"
    const val KEYBOARD_SETTINGS = "settings/keyboard"

    /** Intent for an app route (expo-router path), always resolved inside this package. */
    fun intent(context: Context, path: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse("$SCHEME://${path.trimStart('/')}"))
            .setPackage(context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    /** Opens [path] in the app; falls back to the launcher activity. Never throws. */
    fun open(context: Context, path: String = ""): Boolean {
        val attempts = listOfNotNull(
            if (path.isNotBlank()) intent(context, path) else null,
            context.packageManager.getLaunchIntentForPackage(context.packageName)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        for (i in attempts) {
            if (runCatching { context.startActivity(i) }.onFailure { Log.w(TAG, "could not open $i", it) }.isSuccess) return true
        }
        return false
    }

    fun openKeyboardSettings(context: Context): Boolean = open(context, KEYBOARD_SETTINGS)
}

/**
 * No-UI trampoline named by the IME and accessibility metadata (android:settingsActivity): the
 * system's "keyboard settings" gear and the accessibility settings page open the app's Keyboard screen.
 */
class KeyboardSettingsActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppLink.openKeyboardSettings(this)
        finish()
    }
}
