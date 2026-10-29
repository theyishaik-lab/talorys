import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { cooldownFor } from "../src/ai/cooldown";
import { FallbackProvider, shouldFallBack } from "../src/ai/fallback";
import { modelCaps } from "../src/ai/model-caps";
import {
  ENDPOINT_PRESETS,
  EndpointStore,
  FirstByteTimeoutError,
  firstByteTimeoutSFor,
  OpenAICompatibleProvider,
  visiblePresets,
  withFirstByteTimeout,
  withoutReasoningContent,
} from "../src/ai/openai-compatible";
import { type AgentEvent, classifyAiError, type ToolRequest } from "../src/ai/provider";
import { loggedIn } from "./helpers";

const NVIDIA = "https://integrate.api.nvidia.com/v1";

function memoryStore() {
  const data = new Map<string, unknown>();
  return { getJson: <T>(k: string) => (data.get(k) as T) ?? null, setJson: (k: string, v: unknown) => void data.set(k, v) };
}

const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });

const delta = (model: string, d: Record<string, unknown>, finish: string | null = null) => ({
  id: "c",
  object: "chat.completion.chunk",
  created: 1,
  model,
  choices: [{ index: 0, delta: d, finish_reason: finish }],
});

describe("NVIDIA build preset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("points at integrate.api.nvidia.com with a 20 s first-byte timeout; GitHub Models is hidden and refused", () => {
    expect(ENDPOINT_PRESETS.nvidia).toMatchObject({ name: "NVIDIA", baseURL: NVIDIA });
    expect(visiblePresets().nvidia).toBeDefined();
    expect(visiblePresets().github).toBeUndefined();
    expect(ENDPOINT_PRESETS.github?.deprecated).toMatch(/retired/);
    expect(firstByteTimeoutSFor({ baseURL: NVIDIA })).toBe(20);
    expect(firstByteTimeoutSFor({ baseURL: NVIDIA, firstByteTimeoutS: 0 })).toBe(0);
    expect(firstByteTimeoutSFor({ baseURL: "https://api.groq.com/openai/v1" })).toBe(0);

    const store = new EndpointStore(memoryStore());
    expect(store.upsert("nvidia", {})).toEqual({ id: "nvidia", name: "NVIDIA", baseURL: NVIDIA });
    expect(store.upsert("nvidia", { firstByteTimeoutS: 12 }).firstByteTimeoutS).toBe(12);
    expect(store.upsert("nvidia", { firstByteTimeoutS: null }).firstByteTimeoutS).toBeUndefined();
    // A custom-named endpoint at NVIDIA's URL gets the same default timeout.
    expect(firstByteTimeoutSFor(store.upsert("my-nv", { name: "My NV", baseURL: `${NVIDIA}/` }))).toBe(20);
    expect(() => store.upsert("github", {})).toThrow();
    expect(() => store.upsert("gh", { baseURL: "https://models.github.ai/inference" })).toThrow(/retired/);
  });

  it("API: PUT /api/ai/endpoints/nvidia stores the key and reports the effective timeout", async () => {
    const c = await loggedIn();
    const r = await c.json("/api/ai/endpoints/nvidia", { method: "PUT", body: { key: "nvapi-test-key-abcd1234" } });
    expect(r.endpoint).toMatchObject({ id: "nvidia", name: "NVIDIA", baseURL: NVIDIA, effectiveFirstByteTimeoutS: 20, key: { set: true } });
    expect(JSON.stringify(r)).not.toContain("nvapi-test");
    const list = await c.json("/api/ai/endpoints");
    expect(list.presets.nvidia.baseURL).toBe(NVIDIA);
    expect(list.presets.github).toBeUndefined();
    expect((await c.call("/api/ai/endpoints/nvidia", { method: "PUT", body: { firstByteTimeoutS: 400 } })).status).toBe(400);
    expect((await c.call("/api/ai/endpoints/github", { method: "PUT", body: {} })).status).toBe(400);
    await c.call("/api/ai/endpoints/nvidia", { method: "DELETE" });
  });

  it("caps: DeepSeek V4.1 Flash and GLM-5.3 Flash on NVIDIA, Kimi K2.6 elsewhere", () => {
    expect(modelCaps("openai-compatible", "nvidia/deepseek-ai/deepseek-v4.1-flash")).toMatchObject({ context: 1_048_576, maxOutput: 393_216, tools: true, reasoning: "default" });
    expect(modelCaps("openai-compatible", "nvidia/z-ai/glm-5.3-flash")).toMatchObject({ context: 1_048_576, maxOutput: 131_072, tools: true, reasoning: "always" });
    expect(modelCaps("openrouter", "moonshotai/kimi-k2.6")).toMatchObject({ context: 262_144, maxOutput: 32_768, tools: true });
    expect(modelCaps("openrouter", "deepseek/deepseek-v4.1-flash").context).toBe(1_048_576);
  });

  it("runs a two-step tool loop with Bearer auth, the tools sent, and reasoning_content stripped on the way back", async () => {
    const model = "deepseek-ai/deepseek-v4.1-flash";
    const sent: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        const body = (await req.clone().json()) as Record<string, unknown>;
        sent.push({ url: req.url, auth: req.headers.get("authorization"), body });
        if (sent.length === 1) {
          return sse([
            delta(model, { role: "assistant", reasoning_content: "I should look the task list up." }),
            delta(model, { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "list_tasks", arguments: "" } }] }),
            delta(model, { tool_calls: [{ index: 0, function: { arguments: '{"status":"open"}' } }] }),
            delta(model, {}, "tool_calls"),
          ]);
        }
        return sse([delta(model, { role: "assistant", content: "You have 2 open tasks." }), delta(model, {}, "stop")]);
      }),
    );
    const endpoints = new EndpointStore(memoryStore());
    endpoints.upsert("nvidia", {});
    const provider = new OpenAICompatibleProvider(`nvidia/${model}`, endpoints, { get: async () => "nvapi-secret-1234" });
    const executed: unknown[] = [];
    const req: ToolRequest = {
      system: "s",
      messages: [{ role: "user", content: "what's open?" }],
      maxOutputTokens: 500,
      maxIterations: 4,
      toolBudgetExhausted: () => false,
      tools: [{ name: "list_tasks", description: "List tasks", inputSchema: z.object({ status: z.string() }), execute: async (input) => (executed.push(input), [{ id: 1 }, { id: 2 }]) }],
    };
    const events: AgentEvent[] = [];
    for await (const e of provider.generateWithTools(req)) events.push(e);

    expect(executed).toEqual([{ status: "open" }]);
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("You have 2 open tasks.");
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ url: `${NVIDIA}/chat/completions`, auth: "Bearer nvapi-secret-1234", body: { model } });
    expect((sent[0]!.body.tools as unknown[]).length).toBe(1);
    const second = sent[1]!.body.messages as Record<string, unknown>[];
    const assistant = second.find((m) => m.role === "assistant")!;
    expect(assistant.tool_calls).toHaveLength(1);
    expect("reasoning_content" in assistant).toBe(false);
    expect(second.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true);
  });
});

describe("first-byte timeout", () => {
  const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

  it("cuts off a request whose headers never arrive", async () => {
    const t0 = Date.now();
    await expect(withFirstByteTimeout(hang, 50)("https://x", {})).rejects.toBeInstanceOf(FirstByteTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("cuts off a response whose body sends nothing, and lets a live stream run past the limit", async () => {
    const silent = (async () => new Response(new ReadableStream({ start() {} }), { status: 200 })) as unknown as typeof fetch;
    const res = await withFirstByteTimeout(silent, 50)("https://x", {});
    await expect(res.text()).rejects.toBeInstanceOf(FirstByteTimeoutError);

    const slow = (async () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(new TextEncoder().encode("a"));
            await new Promise((r) => setTimeout(r, 120));
            c.enqueue(new TextEncoder().encode("b"));
            c.close();
          },
        }),
      )) as unknown as typeof fetch;
    expect(await (await withFirstByteTimeout(slow, 50)("https://x", {})).text()).toBe("ab");
  });

  it("passes the caller's own abort through", async () => {
    const controller = new AbortController();
    const seen: AbortSignal[] = [];
    const f = ((_i: unknown, init?: RequestInit) => {
      seen.push(init!.signal!);
      return new Promise<Response>((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }) as unknown as typeof fetch;
    const p = withFirstByteTimeout(f, 5_000)("https://x", { signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(seen[0]!.aborted).toBe(true);
  });

  it("is a fallback reason with a short pause (1 min doubling, at most 10 min)", () => {
    const e = classifyAiError(new FirstByteTimeoutError(20_000), "openai-compatible", "nvidia/z-ai/glm-5.3-flash");
    expect(e.code).toBe("AI_UNAVAILABLE");
    expect(e.details).toMatchObject({ reason: "timeout", timeout_s: 20, timeout_kind: "first_byte" });
    expect(shouldFallBack(e)).toBe(true);
    // The AI SDK may wrap it ("Failed to process successful response", cause: …).
    const wrapped = classifyAiError(Object.assign(new Error("Failed to process successful response"), { cause: new FirstByteTimeoutError(20_000) }), "openai-compatible");
    expect(wrapped.details).toMatchObject({ reason: "timeout", timeout_kind: "first_byte" });
    const now = Date.now();
    expect(cooldownFor(e, now, 1)?.ms).toBe(60_000);
    expect(cooldownFor(e, now, 3)?.ms).toBe(240_000);
    expect(cooldownFor(e, now, 9)?.ms).toBe(600_000);
  });

  it("moves the chain on when an NVIDIA model hangs", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    try {
      const endpoints = new EndpointStore(memoryStore());
      endpoints.upsert("nvidia", { firstByteTimeoutS: 1 });
      const nvidia = new OpenAICompatibleProvider("nvidia/deepseek-ai/deepseek-v4.1-flash", endpoints, { get: async () => "k-12345678" });
      const backup = {
        id: "gemini",
        modelId: "gemini-3.8-flash",
        async generate() {
          return { text: "backup", usage: { inputTokens: 1, outputTokens: 1 } };
        },
        async *stream() {},
        async *generateWithTools(): AsyncIterable<AgentEvent> {
          yield { type: "text", delta: "backup" };
        },
      };
      // Watchdog far above the endpoint timeout, so the endpoint's own timer is what moves on.
      const chain = new FallbackProvider([nvidia, backup], undefined, 60_000);
      const out = await chain.generate({ system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10 });
      expect(out.text).toBe("backup");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("reasoning_content retry", () => {
  const body = JSON.stringify({
    model: "deepseek-ai/deepseek-v4.1-flash",
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "", reasoning_content: "r", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "[]" },
    ],
  });

  it("sends the reasoning back once when a stripped request is refused for missing it, and keeps it after", async () => {
    const bodies: string[] = [];
    const f = withoutReasoningContent((async (_i: unknown, init?: RequestInit) => {
      bodies.push(init!.body as string);
      return init!.body!.toString().includes("reasoning_content")
        ? new Response("{}", { status: 200 })
        : new Response('{"error":{"message":"The reasoning_content in the thinking mode must be passed back to the API."}}', { status: 400 });
    }) as typeof fetch);
    const url = "https://retry.example/v1/chat/completions";
    expect((await f(url, { method: "POST", body })).status).toBe(200);
    expect(bodies.map((b) => b.includes("reasoning_content"))).toEqual([false, true]);
    expect((await f(url, { method: "POST", body })).status).toBe(200);
    expect(bodies.map((b) => b.includes("reasoning_content"))).toEqual([false, true, true]);
  });

  it("does not retry other 400s", async () => {
    let calls = 0;
    const f = withoutReasoningContent((async () => {
      calls++;
      return new Response('{"error":"temperature must be 1.0"}', { status: 400 });
    }) as unknown as typeof fetch);
    expect((await f("https://other.example/v1/chat/completions", { method: "POST", body })).status).toBe(400);
    expect(calls).toBe(1);
  });
});
