import { describe, expect, it } from "vitest";
import { client, inAgent, loggedIn, password } from "./helpers";

/**
 * Oct 30, 2026: the Android keyboard's Ask sheet (POST /api/chat/sync) showed only "empty reply"
 * while every model in the chain was failing: the endpoint swallowed the turn's error event and
 * answered 200 {"reply":""}. Each keyboard message also started a new conversation.
 */
describe("POST /api/chat/sync", () => {
  it("returns the reply and the conversation id, and continues that conversation on a follow-up", async () => {
    const c = await loggedIn();
    const first = await c.call("/api/chat/sync", { method: "POST", body: { message: "list tasks", context: "App: Notes" } });
    expect(first.status).toBe(200);
    const a = (await first.json()) as any;
    expect(a.reply.trim().length).toBeGreaterThan(0);
    expect(typeof a.conversation_id).toBe("string");

    const second = await c.call("/api/chat/sync", { method: "POST", body: { message: "list tasks", conversation_id: a.conversation_id } });
    expect(second.status).toBe(200);
    const b = (await second.json()) as any;
    expect(b.conversation_id).toBe(a.conversation_id);
    const msgs = (await c.json(`/api/conversations/${a.conversation_id}`)).messages;
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[0].content.startsWith("[Context: App: Notes]")).toBe(true);
    await c.call(`/api/conversations/${a.conversation_id}`, { method: "DELETE" });
  });

  it("answers a failed turn with an error status and the reason instead of an empty 200", async () => {
    const c = await loggedIn();
    await c.json("/api/settings", { method: "PATCH", body: { limits: { maxAiRequestsPerDay: 1 } } });
    await inAgent((a) => a.services.usage.increment({ ai_requests: 5 }));
    try {
      const res = await c.call("/api/chat/sync", { method: "POST", body: { message: "hello" } });
      expect(res.status).toBe(429);
      const body = (await res.json()) as any;
      expect(body.error.code).toBe("AI_LIMIT_REACHED");
      expect(body.error.message.length).toBeGreaterThan(0);
      expect(typeof body.error.details.conversation_id).toBe("string");
      await c.call(`/api/conversations/${body.error.details.conversation_id}`, { method: "DELETE" });
    } finally {
      await c.json("/api/settings", { method: "PATCH", body: { limits: { maxAiRequestsPerDay: 200 } } });
      await inAgent((a) => a.services.db.run(`DELETE FROM tal_usage_daily`));
    }
  });

  it("works with the native bearer token the keyboard stores (no cookie)", async () => {
    const login = await client().call("/api/auth/login", { method: "POST", body: { password: password() }, headers: { "x-talorys-client": "native" } });
    const { token } = (await login.json()) as { token: string };
    const kb = client();
    const res = await kb.call("/api/chat/sync", { method: "POST", body: { message: "list tasks" }, headers: { authorization: `Bearer ${token}`, origin: "" } });
    expect(res.status).toBe(200);
    const out = (await res.json()) as any;
    expect(out.reply.length).toBeGreaterThan(0);
    const unauth = await client().call("/api/chat/sync", { method: "POST", body: { message: "x" }, headers: { authorization: "Bearer nope", origin: "" } });
    expect(unauth.status).toBe(401);
    const c = await loggedIn();
    await c.call(`/api/conversations/${out.conversation_id}`, { method: "DELETE" });
  });

  it("rejects an unknown conversation id with 404", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/chat/sync", { method: "POST", body: { message: "hi", conversation_id: "no-such-conversation" } });
    expect(res.status).toBe(404);
  });
});
