package com.talorys.keyboard

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class ChatErrorTest {
    @Test fun modelFailureCarriesReasonAndAttempts() {
        val body = """{"error":{"code":"AI_UNAVAILABLE","message":"None of the models answered.","details":{"attempts_text":"Gemini 3.8 Flash (Google): key rejected · GLM 5.3 Flash (NVIDIA): no answer in 15 s"}}}"""
        val e = ChatError.fromHttp(503, body)
        assertEquals(ChatError.Kind.MODELS_FAILED, e.kind)
        assertEquals("None of the models answered.", e.reason)
        assertTrue(e.attempts!!.contains("key rejected"))
        assertEquals("HTTP 503 · AI_UNAVAILABLE: None of the models answered.", e.summary())
    }

    @Test fun classifiesStatuses() {
        assertEquals(ChatError.Kind.AUTH_EXPIRED, ChatError.fromHttp(401, """{"error":{"code":"UNAUTHORIZED","message":"Please sign in."}}""").kind)
        assertEquals(ChatError.Kind.FORBIDDEN, ChatError.fromHttp(403, "").kind)
        assertEquals(ChatError.Kind.NOT_FOUND, ChatError.fromHttp(404, "<html>nope</html>").kind)
        assertEquals(ChatError.Kind.HTTP, ChatError.fromHttp(404, """{"error":{"code":"NOT_FOUND","message":"Conversation not found"}}""").kind)
        assertEquals(ChatError.Kind.BUSY, ChatError.fromHttp(409, "").kind)
        assertEquals(ChatError.Kind.LIMIT, ChatError.fromHttp(429, """{"error":{"code":"AI_LIMIT_REACHED","message":"Daily limit"}}""").kind)
        assertEquals(ChatError.Kind.HTTP, ChatError.fromHttp(500, "", "Internal Server Error").kind)
        assertEquals("HTTP 500: Internal Server Error", ChatError.fromHttp(500, "", "Internal Server Error").summary())
        assertEquals("HTML page instead of JSON", ChatError.fromHttp(502, "<html>").reason)
    }

    @Test fun classifiesTransportFailures() {
        assertEquals(ChatError.Kind.TIMEOUT, ChatError.fromIo(SocketTimeoutException("timeout")).kind)
        assertEquals(ChatError.Kind.NETWORK, ChatError.fromIo(UnknownHostException("no host")).kind)
    }
}
