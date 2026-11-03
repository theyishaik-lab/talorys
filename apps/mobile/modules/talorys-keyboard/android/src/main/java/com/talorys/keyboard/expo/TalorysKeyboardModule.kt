package com.talorys.keyboard.expo

import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import com.talorys.keyboard.AgentClient
import com.talorys.keyboard.DictionarySync
import com.talorys.keyboard.KeyboardBridge
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * JS ⇄ keyboard bridge (`requireNativeModule("TalorysKeyboard")`). Typed on the JS side in
 * modules/talorys-keyboard/index.ts. The keyboard UI itself (IME, suggestion strip, Ask sheet)
 * stays native; this module only carries the session and the settings.
 */
class TalorysKeyboardModule : Module() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    override fun definition() = ModuleDefinition {
        Name("TalorysKeyboard")

        Function("getConstants") { KeyboardBridge.constants() }

        OnDestroy { scope.cancel() }

        // ---- one login ----
        Function("setSession") { server: String?, token: String? ->
            AgentClient.get(context).setSession(server, token)
        }

        // ---- setup / status ----
        Function("getStatus") { KeyboardBridge.status(context) }
        Function("openInputMethodSettings") { start(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)) }
        Function("showInputMethodPicker") {
            val imm = context.getSystemService(InputMethodManager::class.java)
            imm?.showInputMethodPicker() != null
        }
        Function("openAccessibilitySettings") { start(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        Function("openAssistantSettings") {
            listOf(Settings.ACTION_VOICE_INPUT_SETTINGS, Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS, Settings.ACTION_SETTINGS)
                .any { start(Intent(it)) }
        }

        // ---- preferences ----
        Function("getPreferences") { KeyboardBridge.preferences(context) }
        Function("setPreferences") { values: Map<String, Any?> -> KeyboardBridge.setPreferences(context, values) }

        // ---- learned words + backup ----
        Function("getDictionaryStatus") { KeyboardBridge.dictionaryStatus(context) }
        Function("clearLearnedWords") { KeyboardBridge.clearLearnedWords(context) }
        AsyncFunction("syncDictionary") { promise: Promise ->
            val ctx = context
            scope.launch {
                runCatching { withContext(Dispatchers.IO) { DictionarySync.runOnce(ctx) } }
                    .onSuccess { promise.resolve(KeyboardBridge.dictionaryStatus(ctx)) }
                    .onFailure { promise.reject("ERR_KEYBOARD_SYNC", it.message ?: it.javaClass.simpleName, it) }
            }
        }
        AsyncFunction("restoreDictionary") { promise: Promise ->
            val ctx = context
            scope.launch {
                runCatching { withContext(Dispatchers.IO) { DictionarySync.restore(ctx) } }
                    .onSuccess { promise.resolve(KeyboardBridge.dictionaryStatus(ctx)) }
                    .onFailure { promise.reject("ERR_KEYBOARD_RESTORE", it.message ?: it.javaClass.simpleName, it) }
            }
        }

        // ---- words learned from the screen ----
        Function("getScreenWords") { query: String -> KeyboardBridge.screenWords(context, query) }
        Function("deleteScreenWord") { lang: String, word: String -> KeyboardBridge.deleteScreenWord(context, lang, word) }
        Function("clearScreenWords") { KeyboardBridge.clearScreenWords(context) }
        Function("getExcludedApps") { KeyboardBridge.excludedApps(context) }
        Function("setExcludedApps") { apps: List<String>? -> KeyboardBridge.setExcludedApps(context, apps) }

        // ---- clipboard history ----
        Function("getClipboard") { KeyboardBridge.clipboard(context) }
        Function("deleteClip") { id: Double -> KeyboardBridge.deleteClip(context, id.toLong()) }
        Function("pinClip") { id: Double, pinned: Boolean -> KeyboardBridge.pinClip(context, id.toLong(), pinned) }
        Function("clearClipboard") { includePinned: Boolean -> KeyboardBridge.clearClipboard(context, includePinned) }
    }

    /** Starts a system screen from the current activity (or a new task). False if nothing handles it. */
    private fun start(intent: Intent): Boolean {
        val activity = appContext.currentActivity
        return runCatching {
            if (activity != null) activity.startActivity(intent)
            else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }.isSuccess
    }
}
