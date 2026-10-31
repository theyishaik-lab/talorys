package com.talorys.keyboard

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject

/**
 * Why an Ask request failed, classified so the chat sheet can say exactly what happened
 * (HTTP status + the agent's reason) instead of a generic "no reply". Pure Kotlin, unit-tested.
 */
data class ChatError(
    val kind: Kind,
    /** HTTP status, 0 when the request never got a response. */
    val httpCode: Int = 0,
    /** The agent's error code (e.g. AI_UNAVAILABLE), when it sent its error envelope. */
    val code: String? = null,
    /** The agent's message, or the network error's text. */
    val reason: String? = null,
    /** "Model (Provider): why · …" for every model the agent tried, when a model failure ended the turn. */
    val attempts: String? = null,
) {
    enum class Kind {
        /** 401: the session token expired or was revoked (native tokens last 30 days). Sign in again. */
        AUTH_EXPIRED,
        /** 403: the agent refused the request (CSRF header missing, or not allowed). */
        FORBIDDEN,
        /** 404 with no envelope: wrong agent URL, or an agent too old to have /chat/sync. */
        NOT_FOUND,
        /** 409: a reply is already being generated in this conversation. */
        BUSY,
        /** 429: the agent's daily AI request limit or a rate limit. */
        LIMIT,
        /** 503 from a model failure: every model in the agent's chain failed. */
        MODELS_FAILED,
        /** Any other HTTP error. */
        HTTP,
        /** 200 but the reply was empty (an agent older than 0.1.17 hides its errors this way). */
        EMPTY,
        /** No response at all within the timeout. */
        TIMEOUT,
        /** DNS / connection / TLS failure. */
        NETWORK,
        /** The body wasn't the expected JSON (an HTML page usually means the URL lacks /api). */
        BAD_RESPONSE,
    }

    /** One-line technical summary, e.g. "HTTP 503 · AI_UNAVAILABLE: None of the models answered." */
    fun summary(): String = buildString {
        if (httpCode > 0) append("HTTP ").append(httpCode)
        if (!code.isNullOrBlank()) {
            if (isNotEmpty()) append(" · ")
            append(code)
        }
        if (!reason.isNullOrBlank()) {
            if (isNotEmpty()) append(": ")
            append(reason)
        }
    }

    companion object {
        private val json = Json { ignoreUnknownKeys = true }

        /** Classifies an HTTP error response from its status and body (the agent's {"error":{…}} envelope). */
        fun fromHttp(httpCode: Int, body: String, statusText: String = ""): ChatError {
            val env = runCatching { json.parseToJsonElement(body).jsonObject["error"] as? JsonObject }.getOrNull()
            val code = (env?.get("code") as? JsonPrimitive)?.content
            val message = (env?.get("message") as? JsonPrimitive)?.content
            val details = env?.get("details") as? JsonObject
            val attempts = (details?.get("attempts_text") as? JsonPrimitive)?.content?.takeIf { it.isNotBlank() }
            val reason = message ?: statusText.takeIf { it.isNotBlank() }
                ?: if (body.trimStart().startsWith("<")) "HTML page instead of JSON" else body.trim().take(160).ifBlank { null }
            val kind = when {
                httpCode == 401 -> Kind.AUTH_EXPIRED
                httpCode == 403 -> Kind.FORBIDDEN
                httpCode == 404 && code == null -> Kind.NOT_FOUND
                httpCode == 409 -> Kind.BUSY
                httpCode == 429 -> Kind.LIMIT
                httpCode == 503 && (code == "AI_UNAVAILABLE" || code == "AI_QUOTA_EXHAUSTED" || code == "NOT_CONFIGURED") -> Kind.MODELS_FAILED
                else -> Kind.HTTP
            }
            return ChatError(kind, httpCode, code, reason, attempts)
        }

        /** Classifies a transport failure (no HTTP response). */
        fun fromIo(e: Throwable): ChatError {
            val timeout = e is java.net.SocketTimeoutException || e is java.io.InterruptedIOException ||
                (e.message ?: "").contains("timeout", ignoreCase = true)
            return ChatError(if (timeout) Kind.TIMEOUT else Kind.NETWORK, reason = e.localizedMessage ?: e.javaClass.simpleName)
        }
    }
}
