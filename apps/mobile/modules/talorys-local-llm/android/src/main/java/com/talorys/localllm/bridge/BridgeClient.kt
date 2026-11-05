package com.talorys.localllm.bridge

import android.os.Build
import android.util.Log
import com.talorys.localllm.LocalLlm
import com.talorys.localllm.Logic
import com.talorys.localllm.ModelSpecs
import com.talorys.localllm.engine.ChatTurn
import com.talorys.localllm.engine.GenEvent
import com.talorys.localllm.engine.LlmException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

private const val TAG = "TalorysBridge"
/** Must match DEVICE_BRIDGE_PROTOCOL / DEVICE_BRIDGE_PATH in packages/shared/src/device.ts. */
private const val PROTOCOL = 1
private const val PATH = "/api/device/bridge"

/**
 * The phone's end of the device bridge (docs/local-models.md): one WebSocket to the agent's Durable
 * Object, authenticated with the app's native bearer token. It reports the on-device models and
 * answers `generate` requests for chain entries `{ provider: "device" }` with the local engine.
 *
 * Open only while someone holds it — the app in the foreground ("foreground"), or the keyboard's
 * companion foreground service when "Keep connected in background" is on ("companion") — and only
 * when at least one model has "Use in chain" switched on. Reconnects with backoff (2 s → 5 min);
 * a 4401 close (session rejected) stops until the session changes.
 *
 * Reserved for later: `command` frames (device_read_screen / device_act) are answered "unsupported".
 */
class BridgeClient(private val hub: LocalLlm) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        // Keeps NAT mappings alive; the Workers runtime answers protocol pings without waking the agent.
        .pingInterval(45, TimeUnit.SECONDS)
        .build()
    private val holders = ConcurrentHashMap.newKeySet<String>()
    private val jobs = ConcurrentHashMap<String, Job>()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var open = false
    @Volatile private var failures = 0
    @Volatile private var unauthorized = false
    @Volatile var state: String = "off"
        private set
    @Volatile var detail: String? = null
        private set
    private var reconnectJob: Job? = null

    fun hold(name: String, on: Boolean) {
        if (on) holders.add(name) else holders.remove(name)
        reconcile()
    }

    /** The session changed (sign-in / sign-out): reconnect with the new token. */
    fun sessionChanged() {
        unauthorized = false
        failures = 0
        disconnect("session changed")
        reconcile()
    }

    @Synchronized
    fun reconcile() {
        val want = holders.isNotEmpty() && hub.session.isSet && hub.prefs.anyInChain() && !unauthorized
        if (want && socket == null) connect()
        else if (!want && socket != null) disconnect("not needed")
        else if (!want) setState(if (unauthorized) "unauthorized" else "off", null)
    }

    private fun setState(s: String, d: String?) {
        state = s
        detail = d
        hub.emit(LocalLlm.Event.Bridge(s, d))
    }

    private fun connect() {
        reconnectJob?.cancel()
        val server = hub.session.server
        val req = Request.Builder()
            .url(server.trimEnd('/') + PATH)
            .header("Authorization", "Bearer ${hub.session.token}")
            .header("x-talorys-client", "native")
            .build()
        setState("connecting", null)
        socket = http.newWebSocket(req, Listener())
    }

    @Synchronized
    private fun disconnect(reason: String) {
        reconnectJob?.cancel()
        val s = socket
        socket = null
        open = false
        s?.close(1000, reason)
        jobs.values.forEach { it.cancel() }
        jobs.clear()
        hub.host.cancel(null)
        setState(if (unauthorized) "unauthorized" else "off", null)
    }

    private fun scheduleReconnect() {
        reconnectJob?.cancel()
        val wait = Logic.reconnectDelayMs(failures++)
        reconnectJob = scope.launch {
            delay(wait)
            synchronized(this@BridgeClient) { if (socket == null) reconcile() }
        }
    }

    /** Sends the models' current state (after a download, a load, a "Use in chain" switch). */
    fun reportStatus() {
        if (!open) {
            reconcile()
            return
        }
        send(JSONObject().put("type", "status").put("models", reports()))
    }

    private fun reports(): JSONArray {
        val arr = JSONArray()
        for (s in hub.statuses()) {
            arr.put(JSONObject().put("id", s.id).put("state", s.state).put("use_in_chain", s.useInChain).put("ram", s.ram).put("backend", s.backend ?: JSONObject.NULL))
        }
        return arr
    }

    private fun send(o: JSONObject) {
        socket?.send(o.toString())
    }

    private fun hello() {
        send(
            JSONObject()
                .put("type", "hello")
                .put("protocol", PROTOCOL)
                .put("device_id", hub.prefs.deviceId)
                .put("device_name", "${Build.MANUFACTURER} ${Build.MODEL}".trim())
                .put("app_version", appVersion())
                .put("ram_bytes", hub.host.totalRamBytes())
                .put("capabilities", JSONArray().put("generate"))
                .put("models", reports()),
        )
    }

    private fun appVersion(): String = runCatching {
        hub.app.packageManager.getPackageInfo(hub.app.packageName, 0).versionName ?: ""
    }.getOrDefault("")

    private fun handle(text: String) {
        val m = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (m.optString("type")) {
            "welcome" -> Unit
            "ping" -> send(JSONObject().put("type", "pong").put("t", m.optLong("t")))
            "generate" -> generate(m)
            "cancel" -> {
                val id = m.optString("id")
                hub.host.cancel(id)
                jobs.remove(id)?.cancel()
            }
            "command" -> send(JSONObject().put("type", "result").put("id", m.optString("id")).put("ok", false).put("error", "unsupported: ${m.optString("name")}"))
        }
    }

    private fun generate(m: JSONObject) {
        val id = m.optString("id")
        val modelId = m.optString("model")
        val spec = ModelSpecs.byId(modelId)
        fun error(code: String, msg: String) = send(JSONObject().put("type", "error").put("id", id).put("code", code).put("message", msg))
        if (spec == null) return error("not_downloaded", "Unknown model $modelId")
        if (!hub.prefs.useInChain(modelId)) return error("not_allowed", "Use in chain is off for ${spec.name} on the phone.")
        val history = mutableListOf<ChatTurn>()
        val arr = m.optJSONArray("messages") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            history.add(ChatTurn(if (o.optString("role") == "assistant") "assistant" else "user", o.optString("content")))
        }
        val temperature = if (m.has("temperature")) m.optDouble("temperature") else null
        jobs[id] = scope.launch {
            send(JSONObject().put("type", "accepted").put("id", id))
            try {
                hub.host.generate(id, spec, m.optString("system"), history, m.optInt("max_output_tokens", spec.maxOutputTokens), temperature) { e ->
                    when (e) {
                        is GenEvent.Phase -> send(JSONObject().put("type", "progress").put("id", id).put("phase", e.phase))
                        is GenEvent.Token -> send(JSONObject().put("type", "token").put("id", id).put("delta", e.delta))
                        is GenEvent.Done -> send(JSONObject().put("type", "done").put("id", id).put("backend", e.backend).put("usage", JSONObject().put("output_tokens", e.outputChars / 3)))
                    }
                }
            } catch (e: LlmException) {
                error(e.code, e.message ?: e.code)
            } catch (t: Throwable) {
                error("error", t.message ?: t.javaClass.simpleName)
            } finally {
                jobs.remove(id)
            }
        }
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            if (webSocket !== socket) return
            open = true
            failures = 0
            setState("connected", null)
            hello()
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (webSocket === socket) handle(text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            closed(webSocket, code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = closed(webSocket, code, reason)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "bridge failed: ${t.message}")
            if (response?.code == 401) unauthorized = true
            closed(webSocket, response?.code ?: 1006, t.message ?: "failure")
        }
    }

    private fun closed(webSocket: WebSocket, code: Int, reason: String) {
        synchronized(this) {
            if (webSocket !== socket) return
            socket = null
            open = false
        }
        jobs.values.forEach { it.cancel() }
        jobs.clear()
        if (code == 4401) unauthorized = true
        if (unauthorized) {
            setState("unauthorized", reason)
            return
        }
        setState("error", "$code $reason".trim())
        if (holders.isNotEmpty() && hub.prefs.anyInChain()) scheduleReconnect()
    }
}
