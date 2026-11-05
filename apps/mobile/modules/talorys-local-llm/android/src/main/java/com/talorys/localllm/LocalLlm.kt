package com.talorys.localllm

import android.content.Context
import com.talorys.localllm.bridge.BridgeClient
import com.talorys.localllm.download.DownloadProgress
import com.talorys.localllm.download.ModelDownloader
import com.talorys.localllm.engine.LlmHost
import java.util.concurrent.CopyOnWriteArraySet

/** One model's status as the Settings screen and the bridge report it. */
data class ModelStatus(
    val id: String,
    val name: String,
    val sizeBytes: Long,
    /** "not_downloaded" | "downloading" | "downloaded" | "loading" | "ready" | "error" */
    val state: String,
    val downloadedBytes: Long,
    val ram: String,
    val useInChain: Boolean,
    val backend: String?,
    val error: String?,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "id" to id, "name" to name, "sizeBytes" to sizeBytes.toDouble(), "state" to state,
        "downloadedBytes" to downloadedBytes.toDouble(), "ram" to ram, "useInChain" to useInChain,
        "backend" to backend, "error" to error,
    )
}

/**
 * The process-wide hub of the local-model module: downloads, the engine, the settings and the device
 * bridge, shared by the Expo module (JS), and by the keyboard's companion service (BridgeKeeper).
 */
class LocalLlm private constructor(context: Context) {
    val app: Context = context.applicationContext
    val prefs = LocalPrefs(app)
    val session = LocalSession.get(app)
    private val listeners = CopyOnWriteArraySet<(Event) -> Unit>()
    private val progress = HashMap<String, DownloadProgress>()

    sealed interface Event {
        data class Progress(val p: DownloadProgress) : Event
        data class State(val id: String) : Event
        data class Bridge(val state: String, val detail: String?) : Event
    }

    val downloader = ModelDownloader(app) { p ->
        synchronized(progress) { progress[p.id] = p }
        emit(Event.Progress(p))
        if (p.phase == "done" || p.phase == "error" || p.phase == "paused") stateChanged(p.id)
    }
    val host = LlmHost(app) { id -> stateChanged(id) }
    val bridge = BridgeClient(this)

    fun addListener(l: (Event) -> Unit) = listeners.add(l)
    fun removeListener(l: (Event) -> Unit) = listeners.remove(l)
    fun emit(e: Event) = listeners.forEach { runCatching { it(e) } }

    fun stateChanged(id: String) {
        emit(Event.State(id))
        bridge.reportStatus()
    }

    fun status(spec: ModelSpec): ModelStatus {
        val p = synchronized(progress) { progress[spec.id] }
        val downloaded = ModelFiles.isDownloaded(app, spec)
        val state = when {
            host.loadingId == spec.id -> "loading"
            host.loadedId == spec.id -> "ready"
            downloader.isActive(spec.id) -> "downloading"
            downloaded -> "downloaded"
            p?.phase == "error" || host.lastError?.first == spec.id -> "error"
            else -> "not_downloaded"
        }
        val bytes = when {
            downloaded -> spec.sizeBytes
            downloader.isActive(spec.id) -> p?.downloadedBytes ?: downloader.partialBytes(spec)
            else -> downloader.partialBytes(spec)
        }
        val error = if (state == "error") (p?.error ?: host.lastError?.second) else null
        return ModelStatus(spec.id, spec.name, spec.sizeBytes, state, bytes, Logic.ramVerdict(spec, host.totalRamBytes()), prefs.useInChain(spec.id), if (host.loadedId == spec.id) host.backend else null, error)
    }

    fun statuses(): List<ModelStatus> = ModelSpecs.ALL.map { status(it) }

    companion object {
        @Volatile private var instance: LocalLlm? = null
        fun get(context: Context): LocalLlm = instance ?: synchronized(this) { instance ?: LocalLlm(context).also { instance = it } }
    }
}
