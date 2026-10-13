import { describe, expect, it } from "vitest";
import { conversationBusy, markProgress, STALE_RUN_MS } from "../src/api/routes/chat";
import { inAgent, loggedIn } from "./helpers";

/**
 * Oct 13, 2026: the native app's streams dropped mid-turn on Yishai's phone; every dropped turn
 * lost its answer (the server aborted on the first failed write), and a write that stalled kept the
 * conversation claimed ("A response is already being generated"). A turn now outlives its client.
 */
describe("chat turns outlive their client", () => {
  it("finishes and saves the answer after the client hangs up mid-stream", async () => {
    const c = await loggedIn();
    const res = await c.call("/api/chat", { method: "POST", body: { message: "list tasks" } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let seen = "";
    while (!seen.includes("event: start")) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    const convId = /"conversation_id":"([^"]+)"/.exec(seen)![1]!;
    await reader.cancel("phone dropped the connection");

    let detail: any;
    for (let i = 0; i < 50; i++) {
      detail = await c.json(`/api/conversations/${convId}`);
      if (!detail.streaming && detail.messages.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(detail.streaming).toBe(false);
    expect(detail.messages.map((m: any) => `${m.role}:${m.status}`)).toEqual(["user:complete", "assistant:complete"]);
    // The conversation is free again: a follow-up is accepted.
    const next = await c.call("/api/chat", { method: "POST", body: { conversation_id: convId, message: "list tasks" } });
    expect(next.status).toBe(200);
    await next.text();
    await c.call(`/api/conversations/${convId}`, { method: "DELETE" });
  });

  it("the heartbeat frame is an SSE comment, which clients skip", async () => {
    // The heartbeat is `: ping\n\n`; a frame without data must not be parsed as an event.
    const frames = ": ping\n\nevent: text\ndata: {\"type\":\"text\",\"delta\":\"x\"}\n\n".split("\n\n").filter((b) => b.split("\n").some((l) => l.startsWith("data:")));
    expect(frames).toHaveLength(1);
  });
});

describe("conversation claims", () => {
  it("treats a run that made progress recently as busy", () => {
    const runs = new Map<string, AbortController>();
    const run = new AbortController();
    markProgress(run, 1_000);
    runs.set("c1", run);
    expect(conversationBusy(runs, "c1", 1_000 + STALE_RUN_MS - 1)).toBe(true);
    expect(run.signal.aborted).toBe(false);
  });

  it("releases and aborts a claim with no progress for STALE_RUN_MS", () => {
    const runs = new Map<string, AbortController>();
    const run = new AbortController();
    markProgress(run, 1_000);
    runs.set("c1", run);
    expect(conversationBusy(runs, "c1", 1_000 + STALE_RUN_MS + 1)).toBe(false);
    expect(run.signal.aborted).toBe(true);
    expect(runs.has("c1")).toBe(false);
  });

  it("a conversation with no run is free", () => {
    expect(conversationBusy(new Map(), "nope")).toBe(false);
  });

  it("the live agent's claim map is empty after a finished turn", async () => {
    const c = await loggedIn();
    await (await c.call("/api/chat", { method: "POST", body: { message: "list tasks" } })).text();
    expect(await inAgent((a) => a.activeRuns.size)).toBe(0);
  });
});
