package com.talorys.localllm.bridge

import android.content.Context
import android.util.Log
import androidx.annotation.Keep
import com.talorys.localllm.LocalLlm

/**
 * Entry points for the keyboard's CompanionService (modules/talorys-keyboard), which calls these by
 * reflection so neither module depends on the other at compile time. While the companion runs in the
 * foreground and "Keep connected in background" is on, the device bridge stays open with the app closed.
 */
@Keep
object BridgeKeeper {
    @JvmStatic
    @Keep
    fun onCompanionForeground(context: Context) {
        runCatching {
            val hub = LocalLlm.get(context)
            hub.bridge.hold("companion", hub.prefs.backgroundBridge)
        }.onFailure { Log.w("TalorysBridge", "companion hold failed", it) }
    }

    @JvmStatic
    @Keep
    fun onCompanionStopped(context: Context) {
        runCatching { LocalLlm.get(context).bridge.hold("companion", false) }
    }
}
