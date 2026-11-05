package com.talorys.localllm.expo

import android.content.Context
import android.os.StatFs
import com.talorys.localllm.LocalLlm
import com.talorys.localllm.ModelFiles
import com.talorys.localllm.ModelSpecs
import com.talorys.localllm.engine.ChatTurn
import com.talorys.localllm.engine.GenEvent
import com.talorys.localllm.engine.LlmException
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.util.concurrent.ConcurrentHashMap

/**
 * JS ⇄ local models (`requireNativeModule("TalorysLocalLlm")`), typed in modules/talorys-local-llm/index.ts:
 * the "Local models" settings screen (download / delete / test / switches), the app's offline chat
 * fallback (generate with streamed tokens), and the device bridge's lifecycle (session, foreground).
 */
class LocalLlmModule : Module() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val gens = ConcurrentHashMap<String, Job>()
    private var listener: ((LocalLlm.Event) -> Unit)? = null

    private val context: Context
        get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

    private val hub: LocalLlm get() = LocalLlm.get(context)

    private fun spec(id: String) = ModelSpecs.byId(id) ?: throw CodedException("ERR_UNKNOWN_MODEL", "Unknown model $id", null)

    override fun definition() = ModuleDefinition {
        Name("TalorysLocalLlm")
        Events("onDownloadProgress", "onModelState", "onToken", "onBridgeState")

        OnCreate {
            val l: (LocalLlm.Event) -> Unit = { e ->
                when (e) {
                    is LocalLlm.Event.Progress -> sendEvent("onDownloadProgress", mapOf("id" to e.p.id, "downloadedBytes" to e.p.downloadedBytes.toDouble(), "totalBytes" to e.p.totalBytes.toDouble(), "phase" to e.p.phase, "error" to e.p.error))
                    is LocalLlm.Event.State -> sendEvent("onModelState", hub.status(spec(e.id)).toMap())
                    is LocalLlm.Event.Bridge -> sendEvent("onBridgeState", mapOf("state" to e.state, "detail" to e.detail))
                }
            }
            listener = l
            hub.addListener(l)
        }

        OnDestroy {
            listener?.let { hub.removeListener(it) }
            hub.bridge.hold("foreground", false)
            scope.cancel()
        }

        Function("getModels") { hub.statuses().map { it.toMap() } }

        Function("getDeviceInfo") {
            val dir = ModelFiles.dir(context)
            mapOf(
                "totalRamBytes" to hub.host.totalRamBytes().toDouble(),
                "freeStorageBytes" to runCatching { StatFs(dir.path).availableBytes.toDouble() }.getOrDefault(0.0),
                "abi" to (android.os.Build.SUPPORTED_ABIS.firstOrNull() ?: ""),
            )
        }

        Function("getSettings") {
            val p = hub.prefs
            mapOf("wifiOnly" to p.wifiOnly, "backgroundBridge" to p.backgroundBridge, "offlineFallback" to p.offlineFallback, "offlineModel" to p.offlineModel)
        }

        Function("setSettings") { values: Map<String, Any?> ->
            val p = hub.prefs
            (values["wifiOnly"] as? Boolean)?.let { p.wifiOnly = it }
            (values["offlineFallback"] as? Boolean)?.let { p.offlineFallback = it }
            (values["offlineModel"] as? String)?.let { p.offlineModel = it }
            (values["backgroundBridge"] as? Boolean)?.let {
                p.backgroundBridge = it
                hub.bridge.hold("companion", it)
            }
            mapOf("wifiOnly" to p.wifiOnly, "backgroundBridge" to p.backgroundBridge, "offlineFallback" to p.offlineFallback, "offlineModel" to p.offlineModel)
        }

        Function("startDownload") { id: String ->
            hub.downloader.start(spec(id), hub.prefs.wifiOnly)
            hub.stateChanged(id)
        }

        Function("pauseDownload") { id: String ->
            hub.downloader.pause(id)
        }

        AsyncFunction("deleteModel") { id: String, promise: Promise ->
            scope.launch {
                val s = spec(id)
                hub.downloader.pause(id)
                if (hub.host.loadedId == id) hub.host.unload()
                ModelFiles.delete(context, s)
                hub.prefs.setUseInChain(id, false)
                hub.stateChanged(id)
                promise.resolve(hub.status(s).toMap())
            }
        }

        Function("setUseInChain") { id: String, on: Boolean ->
            spec(id)
            hub.prefs.setUseInChain(id, on)
            hub.stateChanged(id)
            hub.bridge.reconcile()
            hub.status(spec(id)).toMap()
        }

        AsyncFunction("load") { id: String, promise: Promise ->
            scope.launch {
                try {
                    hub.host.load(spec(id))
                    promise.resolve(hub.status(spec(id)).toMap())
                } catch (e: LlmException) {
                    promise.reject(CodedException("ERR_${e.code.uppercase()}", e.message, e))
                }
            }
        }

        Function("unload") { hub.host.unload() }

        /**
         * Streams an answer: tokens arrive as `onToken` events ({ requestId, delta }); the promise
         * resolves with { text, backend } when done and rejects with ERR_<CODE> (ERR_CANCELLED on cancel).
         */
        AsyncFunction("generate") { requestId: String, id: String, system: String, messages: List<Map<String, Any?>>, maxOutputTokens: Int, promise: Promise ->
            val s = spec(id)
            val history = messages.map { ChatTurn(if (it["role"] == "assistant") "assistant" else "user", (it["content"] as? String).orEmpty()) }
            gens[requestId] = scope.launch {
                val text = StringBuilder()
                try {
                    var backend = "cpu"
                    hub.host.generate(requestId, s, system, history, maxOutputTokens, null) { e ->
                        when (e) {
                            is GenEvent.Token -> {
                                text.append(e.delta)
                                sendEvent("onToken", mapOf("requestId" to requestId, "delta" to e.delta))
                            }
                            is GenEvent.Phase -> sendEvent("onToken", mapOf("requestId" to requestId, "phase" to e.phase))
                            is GenEvent.Done -> backend = e.backend
                        }
                    }
                    promise.resolve(mapOf("text" to text.toString(), "backend" to backend))
                } catch (e: LlmException) {
                    promise.reject(CodedException("ERR_${e.code.uppercase()}", e.message, e))
                } catch (t: Throwable) {
                    promise.reject(CodedException("ERR_ERROR", t.message ?: "error", t))
                } finally {
                    gens.remove(requestId)
                }
            }
        }

        Function("cancel") { requestId: String ->
            hub.host.cancel(requestId)
        }

        // ---- device bridge ----
        Function("setSession") { server: String?, token: String? ->
            hub.session.set(server, token)
            hub.bridge.sessionChanged()
        }

        /** The app came to the foreground (true) or went to the background (false). */
        Function("setForeground") { active: Boolean ->
            hub.bridge.hold("foreground", active)
        }

        Function("getBridgeState") { mapOf("state" to hub.bridge.state, "detail" to hub.bridge.detail) }
    }
}
