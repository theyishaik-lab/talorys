package com.talorys.keyboard

import android.accessibilityservice.AccessibilityService
import android.content.SharedPreferences
import com.talorys.keyboard.screen.ScreenWordLearner
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

/**
 * Reads structural screen context (current app label + focused field's hint/label) and publishes it
 * to [ScreenContext] so the chat sheet can offer it to the agent.
 *
 * Only window-state and focus events are subscribed (no text-change events), and only the field's
 * *hint* is read — never its text. Nothing is sent anywhere by this service; the context is attached
 * to a chat message only if the user keeps the context chip and taps Send.
 *
 * Optional (Settings → Learn words from screen, off by default): when on, window content and scroll
 * events are also subscribed and the visible, non-editable text of non-excluded apps is read on a
 * background thread by [ScreenWordLearner] to learn words for suggestions. Password fields are never
 * read (a window with one is skipped entirely) and nothing leaves the device.
 */
class TalorysAccessibilityService : AccessibilityService() {

    private val prefsListener = SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
        if (key == "screen_learning") applyEventTypes()
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        getSharedPreferences("talorys_ui", MODE_PRIVATE).registerOnSharedPreferenceChangeListener(prefsListener)
        applyEventTypes()
    }

    override fun onDestroy() {
        runCatching { getSharedPreferences("talorys_ui", MODE_PRIVATE).unregisterOnSharedPreferenceChangeListener(prefsListener) }
        super.onDestroy()
    }

    /** Content/scroll events are only subscribed while screen learning is on. */
    private fun applyEventTypes() {
        val info = serviceInfo ?: return
        val base = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or AccessibilityEvent.TYPE_VIEW_FOCUSED
        val learning = AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED or AccessibilityEvent.TYPE_VIEW_SCROLLED
        val want = if (ScreenWordLearner.enabled(this)) base or learning else base
        if (info.eventTypes != want) {
            info.eventTypes = want
            runCatching { serviceInfo = info }
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_VIEW_FOCUSED -> runCatching { updateContext(event) }
            else -> Unit
        }
        when (event.eventType) {
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED,
            AccessibilityEvent.TYPE_VIEW_SCROLLED -> {
                val pkg = event.packageName?.toString()
                // Cheap checks only here; the read itself is debounced and runs off the main thread.
                runCatching { ScreenWordLearner.onWindowEvent(this, pkg) { rootInActiveWindow } }
            }
            else -> Unit
        }
    }

    override fun onInterrupt() = Unit

    private fun updateContext(event: AccessibilityEvent) {
        val pkg = event.packageName?.toString() ?: return
        if (pkg == packageName || pkg == "com.android.systemui") return

        val appLabel = runCatching {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        }.getOrDefault(pkg)

        val fieldHint = focusedFieldHint()?.take(80)
        ScreenContext.update(pkg, if (fieldHint != null) "$appLabel · $fieldHint" else appLabel)
    }

    @Suppress("DEPRECATION") // recycle() is a no-op on API 33+, still needed below
    private fun focusedFieldHint(): String? {
        val focused = findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return null
        return try {
            if (!focused.isEditable) null
            else focused.hintText?.toString()?.takeIf { it.isNotBlank() }
                ?: focused.contentDescription?.toString()?.takeIf { it.isNotBlank() }
        } finally {
            focused.recycle()
        }
    }
}
