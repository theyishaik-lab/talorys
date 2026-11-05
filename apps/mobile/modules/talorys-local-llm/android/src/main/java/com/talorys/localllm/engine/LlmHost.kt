package com.talorys.localllm.engine

import android.app.ActivityManager
import android.content.Context
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.SamplerConfig
import com.google.ai.edge.litertlm.ThinkingConfig
import com.talorys.localllm.Logic
import com.talorys.localllm.ModelFiles
import com.talorys.localllm.ModelSpec
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

private const val TAG = "TalorysLocalLlm"
/** A loaded model is released after this long without a request (it holds 1–3 GB). */
private const val IDLE_UNLOAD_MS = 10 * 60_000L

data class ChatTurn(val role: String, val content: String)

/** What a generation reports while it runs. */
sealed interface GenEvent {
    data class Phase(val phase: String) : GenEvent // "loading" | "prefill" | "thinking"
    data class Token(val delta: String) : GenEvent
    data class Done(val backend: String, val outputChars: Int) : GenEvent
}

class LlmException(val code: String, message: String) : Exception(message)

/**
 * Owns the LiteRT-LM engine: one model in memory at a time, one answer at a time.
 *
 * Load: GPU first (much faster prefill, a fraction of the CPU path's memory on the measured phones),
 * CPU when the GPU engine fails to start. Generate: a fresh Conversation per request, built from the
 * system text and the earlier turns, then the last user message streamed through `sendMessageAsync`.
 * The answer channel is streamed; Spark's reasoning arrives on the "thought" channel and only drives
 * a "thinking" progress signal (and is never shown). Cancel stops the native decode.
 */
class LlmHost(private val context: Context, private val onState: (modelId: String) -> Unit) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()
    @Volatile private var engine: Engine? = null
    @Volatile var loadedId: String? = null
        private set
    @Volatile var loadingId: String? = null
        private set
    @Volatile var backend: String? = null
        private set
    @Volatile var lastError: Pair<String, String>? = null
        private set
    @Volatile private var active: Conversation? = null
    @Volatile private var activeRequest: String? = null
    @Volatile private var cancelled: String? = null
    private var idleJob: Job? = null

    val busy: Boolean get() = activeRequest != null

    fun totalRamBytes(): Long {
        val am = context.getSystemService(ActivityManager::class.java) ?: return 0L
        val info = ActivityManager.MemoryInfo()
        am.getMemoryInfo(info)
        return info.totalMem
    }

    /** Loads [spec] (unloading another model first). Throws [LlmException] with a code the bridge forwards. */
    suspend fun load(spec: ModelSpec, onPhase: (String) -> Unit = {}) = withContext(Dispatchers.Default) {
        lock.withLock { loadLocked(spec, onPhase) }
    }

    private fun loadLocked(spec: ModelSpec, onPhase: (String) -> Unit) {
        if (loadedId == spec.id && engine != null) return
        if (!ModelFiles.isDownloaded(context, spec)) throw LlmException("not_downloaded", "${spec.name} is not downloaded.")
        if (Logic.ramVerdict(spec, totalRamBytes()) == "block") throw LlmException("low_memory", "${spec.name} needs about ${spec.minRamGb.toInt()} GB of RAM; this phone has less.")
        unloadLocked()
        loadingId = spec.id
        onState(spec.id)
        onPhase("loading")
        var failure: Throwable? = null
        try {
            for (b in Logic.backendOrder(spec.preferGpu)) {
                try {
                    val config = EngineConfig(
                        modelPath = ModelFiles.file(context, spec).absolutePath,
                        backend = if (b == "gpu") Backend.GPU() else Backend.CPU(),
                        maxNumTokens = spec.contextTokens,
                        cacheDir = context.cacheDir.path,
                    )
                    val e = Engine(config)
                    e.initialize()
                    engine = e
                    loadedId = spec.id
                    backend = b
                    lastError = null
                    Log.i(TAG, "${spec.id} loaded on $b")
                    return
                } catch (t: Throwable) {
                    if (t is OutOfMemoryError) throw LlmException("low_memory", "Out of memory while loading ${spec.name}.")
                    Log.w(TAG, "${spec.id}: $b backend failed to start", t)
                    failure = t
                }
            }
            val msg = "Could not start ${spec.name}: ${failure?.message ?: "unknown error"}"
            lastError = spec.id to msg
            throw LlmException("load_failed", msg)
        } finally {
            loadingId = null
            onState(spec.id)
            scheduleIdleUnload()
        }
    }

    fun unload() {
        scope.launch { lock.withLock { unloadLocked() } }
    }

    private fun unloadLocked() {
        val id = loadedId
        runCatching { active?.close() }
        active = null
        runCatching { engine?.close() }
        engine = null
        loadedId = null
        backend = null
        if (id != null) onState(id)
    }

    private fun scheduleIdleUnload() {
        idleJob?.cancel()
        idleJob = scope.launch {
            delay(IDLE_UNLOAD_MS)
            if (activeRequest == null) lock.withLock { if (activeRequest == null) unloadLocked() }
        }
    }

    /**
     * Streams one answer. [history] ends with the user's message. Returns when done; throws
     * [LlmException] ("busy", "not_downloaded", "low_memory", "load_failed", "cancelled", "error").
     */
    suspend fun generate(
        requestId: String,
        spec: ModelSpec,
        system: String,
        history: List<ChatTurn>,
        maxOutputTokens: Int,
        temperature: Double?,
        onEvent: (GenEvent) -> Unit,
    ) = withContext(Dispatchers.Default) {
        if (activeRequest != null) throw LlmException("busy", "Another answer is being generated on this phone.")
        activeRequest = requestId
        idleJob?.cancel()
        try {
            lock.withLock {
                loadLocked(spec) { onEvent(GenEvent.Phase(it)) }
                val e = engine ?: throw LlmException("load_failed", "The engine is not loaded.")
                val last = history.lastOrNull { it.role == "user" } ?: throw LlmException("error", "Nothing to answer.")
                val earlier = history.subList(0, history.lastIndexOf(last))
                val sampler = SamplerConfig(topK = 40, topP = 0.95, temperature = (temperature ?: if (spec.reasoning) 0.8 else 0.7).coerceIn(0.0, 1.5))
                val initial = earlier.map { if (it.role == "assistant") Message.model(it.content) else Message.user(it.content) }
                val maxOut = maxOutputTokens.coerceIn(64, spec.maxOutputTokens)
                val config = if (spec.reasoning) {
                    ConversationConfig(
                        systemInstruction = Contents.of(system.ifBlank { "You are a helpful assistant." }),
                        initialMessages = initial,
                        samplerConfig = sampler,
                        maxOutputToken = maxOut,
                        thinkingConfig = ThinkingConfig(enableThinking = true, thinkingTokenBudget = spec.thinkingBudgetTokens),
                    )
                } else {
                    ConversationConfig(
                        systemInstruction = Contents.of(system.ifBlank { "You are a helpful assistant." }),
                        initialMessages = initial,
                        samplerConfig = sampler,
                        maxOutputToken = maxOut,
                    )
                }
                onEvent(GenEvent.Phase("prefill"))
                val conv = e.createConversation(config)
                active = conv
                val strip = Logic.ThinkStripper()
                val thinkTick = Logic.Throttle(2_000)
                var chars = 0
                try {
                    conv.sendMessageAsync(last.content).collect { msg ->
                        val text = msg.contents.contents.filterIsInstance<Content.Text>().joinToString("") { it.text }
                        val thought = msg.channels["thought"]
                        if (!thought.isNullOrEmpty() && thinkTick.ready(System.currentTimeMillis())) onEvent(GenEvent.Phase("thinking"))
                        if (text.isNotEmpty()) {
                            val out = strip.push(text)
                            if (out.isNotEmpty()) {
                                chars += out.length
                                onEvent(GenEvent.Token(out))
                            }
                        }
                    }
                    if (cancelled == requestId) throw LlmException("cancelled", "Cancelled.")
                    val rest = strip.end()
                    if (rest.isNotEmpty()) {
                        chars += rest.length
                        onEvent(GenEvent.Token(rest))
                    }
                    onEvent(GenEvent.Done(backend ?: "cpu", chars))
                } catch (c: CancellationException) {
                    runCatching { conv.cancelProcess() }
                    throw c
                } finally {
                    active = null
                    runCatching { conv.close() }
                }
            }
        } catch (e: LlmException) {
            throw e
        } catch (t: Throwable) {
            if (t is CancellationException || cancelled == requestId) throw LlmException("cancelled", "Cancelled.")
            if (t is OutOfMemoryError) throw LlmException("low_memory", "Out of memory while generating.")
            throw LlmException("error", t.message ?: t.javaClass.simpleName)
        } finally {
            if (cancelled == requestId) cancelled = null
            activeRequest = null
            scheduleIdleUnload()
        }
    }

    /** Stops the running answer when it is [requestId] (or any, when null). */
    fun cancel(requestId: String?) {
        if (requestId != null && requestId != activeRequest) return
        cancelled = activeRequest
        runCatching { active?.cancelProcess() }
    }
}
