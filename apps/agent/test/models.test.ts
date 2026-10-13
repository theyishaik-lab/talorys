import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "../src/api/errors";
import { ModelCatalogService, tiersOf, workersAiModelsFromCatalog } from "../src/ai/catalog";
import { FallbackProvider } from "../src/ai/fallback";
import { isGeminiChatModel } from "../src/ai/gemini";
import { hintOf } from "../src/ai/keys";
import { classifyAiError, type AgentEvent, type AIProvider, type GenerateRequest, type ToolRequest } from "../src/ai/provider";
import { inAgent, loggedIn } from "./helpers";

/** A provider that answers with a fixed text, or throws the given error before saying anything. */
function scripted(id: string, modelId: string, answer: string | Error): AIProvider {
  return {
    id,
    modelId,
    async generate() {
      if (answer instanceof Error) throw answer;
      return { text: answer, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *stream(req: GenerateRequest) {
      yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
    },
    async *generateWithTools(_req: ToolRequest): AsyncIterable<AgentEvent> {
      if (answer instanceof Error) throw answer;
      yield { type: "text", delta: answer };
      yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
}

const req: ToolRequest = { system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10, tools: [], maxIterations: 1, toolBudgetExhausted: () => true };

describe("provider error classification", () => {
  it("maps Workers AI quota and capacity errors as before, with the provider in details", () => {
    const quota = classifyAiError(new Error("AiError: 4006: free allocation exhausted"), "workers-ai");
    expect(quota.code).toBe("AI_QUOTA_EXHAUSTED");
    expect(quota.details).toMatchObject({ provider: "workers-ai" });
    expect(classifyAiError(new Error("3040: capacity"), "workers-ai").code).toBe("AI_UNAVAILABLE");
  });

  it("maps Gemini and OpenRouter answers: bad key, quota, unknown model", () => {
    const badKey = Object.assign(new Error("API key not valid. Please pass a valid API key."), { statusCode: 400 });
    expect(classifyAiError(badKey, "gemini").code).toBe("NOT_CONFIGURED");
    const quota = Object.assign(new Error("RESOURCE_EXHAUSTED"), { statusCode: 429 });
    expect(classifyAiError(quota, "gemini")).toMatchObject({ code: "AI_QUOTA_EXHAUSTED", details: { provider: "gemini" } });
    expect(classifyAiError(quota, "gemini").message).toContain("Google Gemini");
    expect(classifyAiError(Object.assign(new Error("Insufficient credits"), { statusCode: 402 }), "openrouter").code).toBe("AI_QUOTA_EXHAUSTED");
    expect(classifyAiError(Object.assign(new Error("No auth credentials found"), { statusCode: 401 }), "openrouter").code).toBe("NOT_CONFIGURED");
    expect(classifyAiError(Object.assign(new Error("models/x is not found for API version v1beta"), { statusCode: 404 }), "gemini").code).toBe("AI_UNAVAILABLE");
    // A status nested in the cause chain (the AI SDK wraps fetch errors) still counts.
    expect(classifyAiError(new Error("Failed", { cause: { statusCode: 429 } }), "openrouter").code).toBe("AI_QUOTA_EXHAUSTED");
  });

  it("keeps a cancelled turn as a cancellation on every provider", () => {
    expect(classifyAiError(new Error("AbortError: The operation was aborted"), "gemini").message).toContain("cancelled");
  });
});

describe("fallback provider", () => {
  it("answers with the backup when the chosen model has no quota, and says so", async () => {
    const primary = scripted("workers-ai", "@cf/a", new AppError("AI_QUOTA_EXHAUSTED", "spent", { provider: "workers-ai" }));
    const backup = scripted("gemini", "gemini-x", "from backup");
    const seen: AppError[] = [];
    const p = new FallbackProvider(primary, backup, (e) => seen.push(e));
    const events: AgentEvent[] = [];
    for await (const e of p.generateWithTools(req)) events.push(e);
    expect(events[0]).toEqual({ type: "provider", provider: "gemini", model: "gemini-x" });
    expect(events).toContainEqual({ type: "text", delta: "from backup" });
    expect(seen.map((e) => e.code)).toEqual(["AI_QUOTA_EXHAUSTED"]);
    expect((await p.generate(req)).text).toBe("from backup");
  });

  it("does not fall back on other errors, nor after the chosen model started answering", async () => {
    const p = new FallbackProvider(scripted("workers-ai", "@cf/a", new AppError("AI_LIMIT_REACHED", "daily cap")), scripted("gemini", "g", "no"));
    await expect(async () => {
      for await (const _ of p.generateWithTools(req)) void _;
    }).rejects.toMatchObject({ code: "AI_LIMIT_REACHED" });

    const halfway: AIProvider = {
      ...scripted("workers-ai", "@cf/a", "x"),
      async *generateWithTools() {
        yield { type: "text", delta: "half" };
        throw new AppError("AI_QUOTA_EXHAUSTED", "spent");
      },
    };
    const p2 = new FallbackProvider(halfway, scripted("gemini", "g", "no"));
    const out: AgentEvent[] = [];
    await expect(async () => {
      for await (const e of p2.generateWithTools(req)) out.push(e);
    }).rejects.toMatchObject({ code: "AI_QUOTA_EXHAUSTED" });
    expect(out).toEqual([{ type: "text", delta: "half" }]);
  });
});

describe("model catalog", () => {
  it("keeps only text-generation models with function calling, with price, context and tiers", () => {
    const models = workersAiModelsFromCatalog([
      { name: "@cf/zai-org/glm-4.7-flash", description: "Fast", task: { name: "Text Generation" }, properties: [{ property_id: "function_calling", value: "true" }, { property_id: "context_window", value: "131072" }, { property_id: "price", value: [{ unit: "per M input tokens", price: 0.06 }, { unit: "per M output tokens", price: 0.4 }] }] },
      { name: "@cf/meta/llama-3.2-1b-instruct", description: "No tools", task: { name: "Text Generation" }, properties: [{ property_id: "context_window", value: "60000" }] },
      { name: "@cf/meta/llama-guard-3-8b", description: "Guard", task: { name: "Text Generation" }, properties: [{ property_id: "function_calling", value: "true" }] },
      { name: "@cf/baai/bge-m3", description: "Embeddings", task: { name: "Text Embeddings" }, properties: [{ property_id: "function_calling", value: "true" }] },
    ]);
    expect(models.map((m) => m.id)).toEqual(["@cf/zai-org/glm-4.7-flash"]);
    expect(models[0]).toMatchObject({ name: "glm-4.7-flash", context: 131072, tools: true, free: true, price: { input: 0.06, output: 0.4 }, speed: "fast", recommended: true });
  });

  it("tiers models by their names", () => {
    expect(tiersOf("gemini-3.5-flash-lite")).toEqual({ speed: "fast", quality: "basic" });
    expect(tiersOf("gemini-2.5-pro")).toEqual({ speed: "slow", quality: "best" });
    expect(tiersOf("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toEqual({ speed: "fast", quality: "good" });
    expect(tiersOf("@cf/openai/gpt-oss-120b")).toEqual({ speed: "slow", quality: "best" });
    expect(tiersOf("@cf/meta/llama-3.2-1b-instruct").quality).toBe("basic");
    expect(tiersOf("google/gemma-4-26b-a4b-it:free").speed).toBe("fast");
    expect(tiersOf("gemini-3.8-flash")).toEqual({ speed: "fast", quality: "good" });
  });

  it("filters the Gemini list to chat models", () => {
    expect(isGeminiChatModel("models/gemini-3.8-flash", ["generateContent"])).toBe(true);
    expect(isGeminiChatModel("models/gemini-2.5-flash-image", ["generateContent"])).toBe(false);
    expect(isGeminiChatModel("models/gemini-embedding-001", ["embedContent"])).toBe(false);
    expect(isGeminiChatModel("models/gemini-3.8-flash-tts", ["generateContent"])).toBe(false);
    expect(isGeminiChatModel("models/imagen-4", ["predict"])).toBe(false);
  });

  it("lists every provider, with a static Gemini list before a key exists and the chosen model always present", async () => {
    const keys = { info: () => ({ gemini: { set: false, hint: null, added_at: null }, openrouter: { set: false, hint: null, added_at: null } }), has: () => false, get: async () => null };
    const fetchCf = vi.fn(async () => [{ name: "@cf/x/y", description: "", properties: [{ property_id: "function_calling", value: "true" }] }]);
    const svc = new ModelCatalogService({} as Ai, keys as never, fetchCf);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "a/b:free", name: "B (free)", supported_parameters: ["tools"], context_length: 1000, pricing: { prompt: "0", completion: "0" } }, { id: "a/paid", supported_parameters: ["tools"] }] }), { status: 200 })));
    const c = await svc.catalog({ provider: "workers-ai", model: "@cf/old/model" });
    vi.unstubAllGlobals();
    expect(c.providers.map((p) => p.id)).toEqual(["workers-ai", "gemini", "openrouter"]);
    const cf = c.providers[0]!;
    expect(cf.models.map((m) => m.id)).toEqual(["@cf/old/model", "@cf/x/y"]);
    expect(cf.source).toBe("live");
    const gemini = c.providers[1]!;
    expect(gemini).toMatchObject({ connected: false, needsKey: true, source: "static" });
    expect(gemini.models.some((m) => m.id === "gemini-3.8-flash")).toBe(true);
    const or = c.providers[2]!;
    expect(or.models.map((m) => m.id)).toEqual(["a/b:free"]);
    expect(or.models[0]).toMatchObject({ name: "B", free: true, tools: true });
    // Cached: the second call fetches nothing.
    await svc.catalog({ provider: "workers-ai", model: "@cf/x/y" });
    expect(fetchCf).toHaveBeenCalledTimes(1);
  });
});

describe("provider keys", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("stores a key encrypted after the provider accepted it, reports only a hint, and removes it", async () => {
    const c = await loggedIn();
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.startsWith("https://generativelanguage.googleapis.com/v1beta/models")) return new Response(JSON.stringify({ models: [{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 1048576 }] }), { status: 200 });
      return new Response("nope", { status: 500 });
    }));
    const before = await c.json("/api/ai/keys");
    expect(before.keys.gemini.set).toBe(false);

    const bad = await c.call("/api/ai/keys/gemini", { method: "PUT", body: { key: "short" } });
    expect(bad.status).toBe(400);

    const saved = await c.json("/api/ai/keys/gemini", { method: "PUT", body: { key: "AIzaSy-test-key-1234abcd" } });
    expect(saved.key).toMatchObject({ set: true, hint: "…abcd" });
    expect(JSON.stringify(saved)).not.toContain("AIzaSy-test-key");
    expect(saved.check.models).toBe(1);

    // The agent can read it back; the database row is not the plain key.
    await inAgent(async (a) => {
      expect(await a.services.providerKeys.get("gemini")).toBe("AIzaSy-test-key-1234abcd");
      const row = a.services.settings.getJson<Record<string, { data: string }>>("ai.keys");
      expect(row!.gemini.data).not.toContain("test-key");
    });

    const catalog = await c.json("/api/ai/models");
    const gemini = catalog.providers.find((p: { id: string }) => p.id === "gemini");
    expect(gemini).toMatchObject({ connected: true, keyHint: "…abcd", source: "live" });
    expect(gemini.models.map((m: { id: string }) => m.id)).toEqual(["gemini-3.8-flash"]);

    expect((await c.json("/api/ai/keys/gemini/test", { method: "POST" })).ok).toBe(true);
    expect((await c.call("/api/ai/keys/gemini", { method: "DELETE" })).status).toBe(204);
    expect((await c.json("/api/ai/keys")).keys.gemini.set).toBe(false);
    expect((await c.call("/api/ai/keys/workers-ai", { method: "PUT", body: { key: "whatever-key-1234" } })).status).toBe(400);
  });

  it("refuses a key the provider rejects, in the provider's words", async () => {
    const c = await loggedIn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "API key not valid" } }), { status: 400 })));
    const res = await c.call("/api/ai/keys/openrouter", { method: "PUT", body: { key: "sk-or-v1-notvalid" } });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_CONFIGURED");
    expect(body.error.message).toContain("OpenRouter");
  });

  it("hints never reveal more than four characters", () => {
    expect(hintOf("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ1234")).toBe("…1234");
  });
});

describe("settings → model", () => {
  it("persists provider + model and the fallback, and rejects a model id of the wrong provider", async () => {
    const c = await loggedIn();
    const ok = await c.json("/api/settings", { method: "PATCH", body: { modelProvider: "gemini", model: "gemini-3.8-flash", fallback: { enabled: true, provider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash" } } });
    expect(ok.settings).toMatchObject({ modelProvider: "gemini", model: "gemini-3.8-flash", fallback: { enabled: true, provider: "workers-ai" } });
    expect((await c.json("/api/settings")).settings.modelProvider).toBe("gemini");
    expect((await c.json("/api/usage")).provider).toBe("gemini");
    const bad = await c.call("/api/settings", { method: "PATCH", body: { modelProvider: "workers-ai", model: "gemini-3.8-flash" } });
    expect(bad.status).toBe(400);
    // The agent now answers with Gemini (no key yet → a clear NOT_CONFIGURED, not a crash).
    await inAgent(async (a) => {
      const p = a.providerFor("gemini", "gemini-3.8-flash")!;
      expect(p.id).toBe("gemini");
      await expect(p.generate({ system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 5 })).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
    });
    await c.json("/api/settings", { method: "PATCH", body: { modelProvider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash", fallback: { enabled: false } } });
  });
});
