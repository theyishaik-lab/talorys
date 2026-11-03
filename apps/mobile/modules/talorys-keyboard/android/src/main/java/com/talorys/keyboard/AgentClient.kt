package com.talorys.keyboard

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.core.content.edit
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit

private const val TAG = "TalorysAgent"
private val JSON_MEDIA = "application/json".toMediaType()
private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

/** Server-side limits from POST /chat/sync (apps/agent/src/api/routes/chat.ts). */
const val MAX_MESSAGE_CHARS = 8192
const val MAX_CONTEXT_CHARS = 500

@Serializable
data class Suggestion(
    val id: String,
    val title: String,
    val body: String,
    val status: String = "new",
    val proposed_tool: String? = null,
)

@Serializable
data class SuggestionsResponse(
    val suggestions: List<Suggestion> = emptyList(),
    val unseen: Int = 0,
)

@Serializable
data class SyncChatRequest(val message: String, val context: String? = null, val conversation_id: String? = null)

@Serializable
data class SyncChatResponse(val reply: String = "", val conversation_id: String? = null, val model: String? = null)

@Serializable
private data class StatusUpdate(val status: String)

/** An error talking to the agent, with a message fit to show the user. */
class AgentException(
    message: String,
    val httpCode: Int = 0,
    cause: Throwable? = null,
    /** Set for chat requests: the classified reason, shown to the user by the chat sheet. */
    val chatError: ChatError? = null,
) : Exception(message, cause)

/** Outcome of [AgentClient.testConnection]. */
sealed interface ConnectionTest {
    data class Ok(val activeSuggestions: Int) : ConnectionTest
    data class Unauthorized(val code: Int) : ConnectionTest
    data class HttpError(val code: Int, val detail: String) : ConnectionTest
    data class NetworkError(val detail: String) : ConnectionTest
    data class BadResponse(val detail: String) : ConnectionTest
}

/**
 * HTTP client for the Talorys agent worker. One instance per process ([get]) so the IME,
 * services and activities share credentials and the OkHttp connection pool.
 *
 * Credentials live in [EncryptedSharedPreferences]; the AES-256-GCM key is held by the Android
 * Keystore and never leaves the device.
 */
class AgentClient private constructor(context: Context) {

    private val store = SecureStore.open(context)
    private val prefs: SharedPreferences = store.prefs

    /** False when the Keystore was unavailable and the token is kept in plain app-private prefs. */
    val isEncrypted: Boolean = store.encrypted

    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // /chat/sync waits up to 60 s for the whole agent turn.
        .readTimeout(70, TimeUnit.SECONDS)
        .callTimeout(80, TimeUnit.SECONDS)
        .build()

    var agentUrl: String
        get() = prefs.getString("agent_url", "") ?: ""
        set(v) = prefs.edit { putString("agent_url", v) }

    var sessionToken: String
        get() = prefs.getString("session_token", "") ?: ""
        set(v) = prefs.edit { putString("session_token", v) }

    val isConfigured: Boolean get() = agentUrl.isNotBlank() && sessionToken.isNotBlank()

    /**
     * The Talorys app's session (one login for app and keyboard). Called from JS after sign-in,
     * on start-up and on sign-out / 401 ([token] null clears it). [server] is the app's server
     * origin (without /api); the keyboard's paths are relative to {server}/api.
     */
    @Synchronized
    fun setSession(server: String?, token: String?) {
        val url = server?.let { agentApiUrl(it) }.orEmpty()
        prefs.edit {
            if (url.isNotEmpty()) putString("agent_url", url)
            if (token.isNullOrBlank()) remove("session_token") else putString("session_token", token.trim())
        }
    }

    private fun request(base: String, path: String, token: String): Request.Builder =
        Request.Builder()
            .url(base.trimEnd('/') + path)
            .header("Authorization", "Bearer $token")
            .header("Accept", "application/json")
            // Required by the CSRF guard on all state-changing requests.
            .header("X-Talorys-Request", "1")

    /** Active suggestions (status new/seen). Failures are returned, not swallowed, so callers can back off. */
    suspend fun fetchSuggestions(): Result<List<Suggestion>> = withContext(Dispatchers.IO) {
        if (!isConfigured) return@withContext Result.failure(AgentException("not configured"))
        runCatching {
            http.newCall(request(agentUrl, "/suggestions?limit=10", sessionToken).get().build()).execute().use { resp ->
                val body = resp.bodyOrThrow()
                json.decodeFromString<SuggestionsResponse>(body).suggestions.filter { it.status == "new" || it.status == "seen" }
            }
        }.onFailure { Log.w(TAG, "fetchSuggestions failed: ${it.message}") }
    }

    /** Mark a suggestion accepted (inserted) or dismissed. */
    suspend fun setSuggestionStatus(id: String, status: String): Boolean = withContext(Dispatchers.IO) {
        if (!isConfigured) return@withContext false
        runCatching {
            val body = json.encodeToString(StatusUpdate.serializer(), StatusUpdate(status)).toRequestBody(JSON_MEDIA)
            http.newCall(request(agentUrl, "/suggestions/$id", sessionToken).patch(body).build()).execute().use { it.isSuccessful }
        }.onFailure { Log.w(TAG, "setSuggestionStatus failed: ${it.message}") }.getOrDefault(false)
    }

    /**
     * Send one message via POST /chat/sync and return the reply. [screenContext] is structural
     * metadata only (app name + field hint), never field contents. Pass the [conversationId] from
     * the previous reply to continue the same conversation (agents before 0.1.17 ignore it).
     * @throws AgentException whose [AgentException.chatError] says exactly what went wrong.
     */
    suspend fun chat(message: String, screenContext: String?, conversationId: String? = null): SyncChatResponse = withContext(Dispatchers.IO) {
        if (!isConfigured) throw AgentException("not configured")
        val payload = SyncChatRequest(
            message = message.take(MAX_MESSAGE_CHARS),
            context = screenContext?.take(MAX_CONTEXT_CHARS)?.takeIf { it.isNotBlank() },
            conversation_id = conversationId?.takeIf { it.isNotBlank() },
        )
        val body = json.encodeToString(SyncChatRequest.serializer(), payload).toRequestBody(JSON_MEDIA)
        val error: ChatError = try {
            http.newCall(request(agentUrl, "/chat/sync", sessionToken).post(body).build()).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                if (resp.isSuccessful) {
                    val parsed = try {
                        json.decodeFromString<SyncChatResponse>(text)
                    } catch (e: SerializationException) {
                        val why = if (text.trimStart().startsWith("<")) "HTML page instead of JSON (the agent URL should end in /api)" else "invalid JSON"
                        throw AgentException(why, resp.code, e, ChatError(ChatError.Kind.BAD_RESPONSE, resp.code, reason = why))
                    }
                    if (parsed.reply.isNotBlank()) return@withContext parsed
                    ChatError(ChatError.Kind.EMPTY, resp.code)
                } else {
                    ChatError.fromHttp(resp.code, text, resp.message)
                }
            }
        } catch (e: AgentException) {
            throw e
        } catch (e: IOException) {
            ChatError.fromIo(e)
        }
        Log.w(TAG, "chat failed: ${error.summary()}")
        throw AgentException(error.summary().ifBlank { error.kind.name }, error.httpCode, chatError = error)
    }

    /**
     * Path of the keyboard dictionary backup. The saved agent URL normally already ends in /api
     * (like /suggestions and /chat/sync); otherwise /api is added.
     */
    private fun dictionaryPath(): String =
        if (agentUrl.trimEnd('/').endsWith("/api")) "/keyboard/dictionary" else "/api/keyboard/dictionary"

    /** The stored personal dictionary JSON, or null when nothing is stored yet (404 / empty body). */
    suspend fun getDictionary(): String? = withContext(Dispatchers.IO) {
        if (!isConfigured) throw AgentException("not configured")
        try {
            http.newCall(request(agentUrl, dictionaryPath(), sessionToken).get().build()).execute().use { resp ->
                if (resp.code == 404 || resp.code == 204) return@use null
                resp.bodyOrThrow().takeIf { it.isNotBlank() && it.trim() != "null" }
            }
        } catch (e: IOException) {
            throw AgentException(e.localizedMessage ?: e.javaClass.simpleName, cause = e)
        }
    }

    /** Replaces the stored personal dictionary with [jsonBody]. */
    suspend fun putDictionary(jsonBody: String) = withContext(Dispatchers.IO) {
        if (!isConfigured) throw AgentException("not configured")
        try {
            http.newCall(request(agentUrl, dictionaryPath(), sessionToken).put(jsonBody.toRequestBody(JSON_MEDIA)).build()).execute().use { resp ->
                resp.bodyOrThrow()
            }
            Unit
        } catch (e: IOException) {
            throw AgentException(e.localizedMessage ?: e.javaClass.simpleName, cause = e)
        }
    }

    /** Check [url] + [token] (not necessarily saved yet) against GET /suggestions and report exactly what happened. */
    suspend fun testConnection(url: String, token: String): ConnectionTest = withContext(Dispatchers.IO) {
        try {
            http.newCall(request(url, "/suggestions?limit=50", token).get().build()).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                when {
                    resp.code == 401 || resp.code == 403 -> ConnectionTest.Unauthorized(resp.code)
                    !resp.isSuccessful -> ConnectionTest.HttpError(resp.code, errorMessage(text) ?: resp.message.ifBlank { "error" })
                    else -> try {
                        val list = json.decodeFromString<SuggestionsResponse>(text).suggestions
                        ConnectionTest.Ok(list.count { it.status == "new" || it.status == "seen" })
                    } catch (e: SerializationException) {
                        ConnectionTest.BadResponse(if (text.trimStart().startsWith("<")) "HTML page (wrong URL? it should end in /api)" else (e.message ?: "invalid JSON").take(120))
                    }
                }
            }
        } catch (e: IOException) {
            ConnectionTest.NetworkError(e.localizedMessage ?: e.javaClass.simpleName)
        } catch (e: IllegalArgumentException) {
            ConnectionTest.NetworkError(e.localizedMessage ?: "invalid URL")
        }
    }

    private fun Response.bodyOrThrow(): String {
        val text = body?.string().orEmpty()
        if (!isSuccessful) throw AgentException(errorMessage(text)?.let { "HTTP $code: $it" } ?: "HTTP $code", code)
        return text
    }

    /** Extracts {"error":{"message":…}} from the worker's error envelope. */
    private fun errorMessage(text: String): String? = runCatching {
        (json.parseToJsonElement(text).jsonObject["error"] as? JsonObject)?.get("message")?.jsonPrimitive?.content
    }.getOrNull()

    companion object {
        @Volatile private var instance: AgentClient? = null

        fun get(context: Context): AgentClient =
            instance ?: synchronized(this) {
                instance ?: AgentClient(context.applicationContext).also { instance = it }
            }

        /** "https://host[/api][/]" → "https://host/api" (what /suggestions, /chat/sync are relative to). Blank for blank. */
        fun agentApiUrl(server: String): String {
            val s = server.trim().trimEnd('/')
            if (s.isEmpty()) return ""
            return if (s.endsWith("/api")) s else "$s/api"
        }

        /** Normalises a user-entered agent URL; returns null unless it's a valid https URL. */
        fun normalizeUrl(raw: String): String? {
            val trimmed = raw.trim().trimEnd('/')
            if (!trimmed.startsWith("https://", ignoreCase = true)) return null
            val parsed = trimmed.toHttpUrlOrNull() ?: return null
            if (parsed.host.isBlank() || !parsed.host.contains('.')) return null
            return trimmed
        }
    }
}

/** Opens the encrypted preference store, recovering from a corrupted keyset before falling back. */
private class SecureStore(val prefs: SharedPreferences, val encrypted: Boolean) {
    companion object {
        private const val FILE = "talorys_keyboard_secure"

        @Suppress("DEPRECATION") // security-crypto 1.1.0 deprecates these APIs, no replacement yet
        private fun create(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }

        fun open(context: Context): SecureStore {
            try {
                return SecureStore(create(context), true)
            } catch (first: Exception) {
                // Typical cause: keyset no longer matches the Keystore key (e.g. after a restore).
                Log.w(TAG, "Encrypted prefs unreadable, resetting the secure store", first)
                runCatching { context.deleteSharedPreferences(FILE) }
                try {
                    return SecureStore(create(context), true)
                } catch (second: Exception) {
                    Log.e(TAG, "Android Keystore unavailable; storing credentials UNENCRYPTED in app-private prefs", second)
                    return SecureStore(context.getSharedPreferences("talorys_keyboard", Context.MODE_PRIVATE), false)
                }
            }
        }
    }
}
