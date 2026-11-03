package com.talorys.keyboard

import android.content.Intent

/**
 * Device-assistant and "Ask Talorys" text-selection entry point. Shares the chat sheet UI and
 * the process-wide [AgentClient] with [ChatActivity] (no service binding, so no race).
 *
 * Handles:
 *  - ACTION_ASSIST / VOICE_COMMAND (hold Home once Talorys is the default digital assistant):
 *    context = label of the app that was in front (EXTRA_ASSIST_PACKAGE).
 *  - ACTION_PROCESS_TEXT ("Ask Talorys" in the text-selection menu): the selected text pre-fills
 *    the composer. It is sent only when the user taps Send.
 */
class AssistActivity : ChatActivity() {

    override fun readScreenContext(intent: Intent): String? {
        val pkg = intent.getStringExtra(Intent.EXTRA_ASSIST_PACKAGE) ?: return null
        if (pkg == packageName) return null
        return runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault(pkg)
    }

    override fun readPrefill(intent: Intent): String? =
        intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.trim()
            ?: intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.trim()
}
