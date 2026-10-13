import { afterEach, describe, expect, it, vi } from "vitest";
import { chainFromSettings, endpointIdFromName, moveItem, settingsPatchForChain } from "@talorys/shared";
import { AppError } from "../src/api/errors";
import { chainStatus } from "../src/ai/chain-status";
import { ModelCooldowns } from "../src/ai/cooldown";
import { observingFetch, parseDuration, parseRateLimitHeaders, QuotaObservations, requestsWindowFor } from "../src/ai/quota";
import { inAgent, loggedIn } from "./helpers";

function memoryStore() {
  const m = new Map<string, unknown>();
  return { getJson: <T>(k: string) => (m.get(k) as T) ?? null, setJson: (k: string, v: unknown) => void m.set(k, JSON.parse(JSON.stringify(v))) };
}

const NOW = Date.parse("2026-10-13T21:00:00Z");

describe("rate-limit headers", () => {
  it("parses Groq durations and counters (requests per day, tokens per minute)", () => {
    expect(parseDuration("2m59.56s")).toBeCloseTo(179.56);
    expect(parseDuration("1h2m3s")).toBe(3723);
    expect(parseDuration("120ms")).toBeCloseTo(0.12);
    expect(parseDuration("43")).toBe(43);
    expect(parseDuration("")).toBeNull();
    const h = new Headers({
      "x-ratelimit-limit-requests": "1000",
      "x-ratelimit-remaining-requests": "987",
      "x-ratelimit-reset-requests": "1m26.4s",
      "x-ratelimit-limit-tokens": "8000",
      "x-ratelimit-remaining-tokens": "7412",
      "x-ratelimit-reset-tokens": "4.41s",
    });
    const s = parseRateLimitHeaders(h, NOW, { requestsWindow: requestsWindowFor("https://api.groq.com/openai/v1") });
    expect(s?.requests).toEqual({ limit: 1000, remaining: 987, reset_at: new Date(NOW + 86_400).toISOString(), window: "day" });
    expect(s?.tokens).toMatchObject({ limit: 8000, remaining: 7412, window: "minute" });
  });

  it("parses the IETF RateLimit-* headers (OVH) and ignores responses without any", () => {
    const s = parseRateLimitHeaders(new Headers({ "RateLimit-Limit": "2", "RateLimit-Remaining": "1", "RateLimit-Reset": "30" }), NOW, { requestsWindow: requestsWindowFor("https://oai.endpoints.kepler.ai.cloud.ovh.net/v1") });
    expect(s?.requests).toEqual({ limit: 2, remaining: 1, reset_at: new Date(NOW + 30_000).toISOString(), window: "minute" });
    expect(s?.tokens).toBeNull();
    expect(parseRateLimitHeaders(new Headers({ "content-type": "application/json" }), NOW)).toBeNull();
    expect(requestsWindowFor("https://api.example.com/v1")).toBeNull();
  });

  it("records the headers of every response and hands the response back untouched", async () => {
    const seen: unknown[] = [];
    const base = vi.fn(async () => new Response("{}", { status: 429, headers: { "x-ratelimit-remaining-requests": "0", "x-ratelimit-limit-requests": "1000" } }));
    const f = observingFetch((s) => seen.push(s), { base: base as unknown as typeof fetch, requestsWindow: "day" });
    const r = await f("https://api.groq.com/openai/v1/chat/completions");
    expect(r.status).toBe(429);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ requests: { remaining: 0, limit: 1000, window: "day" } });
  });

  it("keeps one snapshot per model and forgets old ones", () => {
    let now = NOW;
    const q = new QuotaObservations(memoryStore(), () => now);
    q.record("openai-compatible", "groq/a", { requests: { limit: 1000, remaining: 5, reset_at: null, window: "day" }, tokens: null, seen_at: new Date(now).toISOString() });
    expect(q.get("openai-compatible", "groq/a")?.requests?.remaining).toBe(5);
    expect(q.get("openai-compatible", "groq/b")).toBeNull();
    now += 49 * 3_600_000;
    expect(q.get("openai-compatible", "groq/a")).toBeNull();
  });
});

describe("chain list helpers", () => {
  const settings = {
    modelProvider: "openrouter" as const,
    model: "a/ultra:free",
    fallback: { enabled: true, provider: "openrouter" as const, model: "a/super:free", chain: [{ provider: "gemini" as const, model: "gemini-3.8-flash" }, { provider: "openrouter" as const, model: "a/ultra:free" }] },
  };

  it("lists the chosen model, the backup and the chain once each, and writes an edited list back", () => {
    const list = chainFromSettings(settings);
    expect(list.map((r) => r.model)).toEqual(["a/ultra:free", "a/super:free", "gemini-3.8-flash"]);
    const moved = moveItem(list, 2, 0);
    expect(settingsPatchForChain(moved)).toEqual({
      modelProvider: "gemini",
      model: "gemini-3.8-flash",
      fallback: { provider: "openrouter", model: "a/ultra:free", chain: [{ provider: "openrouter", model: "a/super:free" }] },
    });
    expect(settingsPatchForChain([list[0]!], true)).toEqual({ modelProvider: "openrouter", model: "a/ultra:free", fallback: { enabled: true, provider: "openrouter", model: "a/ultra:free", chain: [] } });
    expect(() => settingsPatchForChain([])).toThrow();
    expect(moveItem([1, 2, 3], 0, 9)).toEqual([2, 3, 1]);
  });

  it("makes endpoint ids from names", () => {
    expect(endpointIdFromName("Groq Cloud")).toBe("groq-cloud");
    expect(endpointIdFromName("Z.ai", ["z-ai"])).toBe("z-ai-2");
    expect(endpointIdFromName("עברית")).toBe("api");
  });
});

describe("chain status", () => {
  const settings = {
    modelProvider: "openrouter" as const,
    model: "nvidia/ultra:free",
    fallback: {
      enabled: true,
      provider: "gemini" as const,
      model: "gemini-3.8-flash",
      chain: [
        { provider: "openai-compatible" as const, model: "groq/openai/gpt-oss-120b" },
        { provider: "gemini" as const, model: "gemini-3.5-flash" },
        { provider: "openai-compatible" as const, model: "gone/x" },
        { provider: "workers-ai" as const, model: "@cf/google/gemma-4-26b-a4b-it" },
      ],
    },
  };

  it("says which models are available, paused, out of daily quota or not set up, and what is left", () => {
    const store = memoryStore();
    const cooldowns = new ModelCooldowns(store, () => NOW);
    const quotas = new QuotaObservations(store, () => NOW);
    cooldowns.failed("gemini", "gemini-3.8-flash", new AppError("AI_UNAVAILABLE", "high demand", { reason: "overloaded", status: 503 }));
    cooldowns.failed("gemini", "gemini-3.5-flash", new AppError("AI_QUOTA_EXHAUSTED", "PerDay quota", { reason: "quota", quota_window: "day" }));
    quotas.record("openai-compatible", "groq/openai/gpt-oss-120b", {
      requests: { limit: 1000, remaining: 990, reset_at: new Date(NOW + 60_000).toISOString(), window: "day" },
      tokens: { limit: 8000, remaining: 8000, reset_at: null, window: "minute" },
      seen_at: new Date(NOW - 5_000).toISOString(),
    });
    const s = chainStatus(settings, {
      cooldowns,
      quotas,
      configured: (r) => !(r.provider === "openai-compatible" && r.model.startsWith("gone/")),
      endpointName: (id) => (id === "groq" ? "Groq" : null),
      openRouter: { used: 20, limit: 50, remaining: 30 },
      now: NOW,
    });
    expect(s.enabled).toBe(true);
    const by = Object.fromEntries(s.entries.map((e) => [e.model, e]));
    expect(s.entries.map((e) => e.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(by["nvidia/ultra:free"]).toMatchObject({ state: "available", provider_label: "OpenRouter", quota: { requests: { remaining: 30, limit: 50, window: "day" }, source: "key_api", shared: true } });
    expect(by["gemini-3.8-flash"]).toMatchObject({ state: "paused", reason: "overloaded", provider_label: "Google", quota: null });
    expect(by["gemini-3.5-flash"]).toMatchObject({ state: "exhausted", reason: "quota" });
    expect(Date.parse(by["gemini-3.5-flash"]!.until!)).toBe(Date.parse("2026-10-14T00:00:00Z"));
    expect(by["groq/openai/gpt-oss-120b"]).toMatchObject({ state: "available", provider_label: "Groq", label: "GPT OSS 120B", quota: { requests: { remaining: 990 }, source: "headers" } });
    expect(by["gone/x"]).toMatchObject({ state: "not_configured" });
    expect(by["@cf/google/gemma-4-26b-a4b-it"]).toMatchObject({ state: "available", provider_label: "Workers AI", quota: null });
  });

  it("marks a model with nothing left as used up even before it failed, and a reset counter as full again", () => {
    const store = memoryStore();
    const quotas = new QuotaObservations(store, () => NOW);
    quotas.record("openai-compatible", "groq/openai/gpt-oss-120b", { requests: { limit: 1000, remaining: 0, reset_at: new Date(NOW + 3_600_000).toISOString(), window: "day" }, tokens: null, seen_at: new Date(NOW).toISOString() });
    const deps = { cooldowns: new ModelCooldowns(store, () => NOW), quotas, configured: () => true, endpointName: () => null, openRouter: { used: 50, limit: 50, remaining: 0 }, now: NOW };
    const s = chainStatus(settings, deps);
    expect(s.entries[0]).toMatchObject({ state: "exhausted", reason: "quota", until: "2026-10-14T00:00:00.000Z" });
    expect(s.entries[2]).toMatchObject({ state: "exhausted", until: new Date(NOW + 3_600_000).toISOString() });
    const later = chainStatus(settings, { ...deps, openRouter: null, now: NOW + 2 * 3_600_000 });
    expect(later.entries[0]).toMatchObject({ state: "available", quota: null });
    expect(later.entries[2]).toMatchObject({ state: "available", quota: { requests: { remaining: 1000, reset_at: null } } });
  });
});

describe("GET /api/ai/chain and endpoint models", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns the live chain in order, records Groq headers from a real call, and lists an endpoint's models", async () => {
    const c = await loggedIn();
    await c.json("/api/ai/endpoints/groq", { method: "PUT", body: { key: "gsk_test_key_1234wxyz" } });
    await c.json("/api/settings", {
      method: "PATCH",
      body: { modelProvider: "openai-compatible", model: "groq/openai/gpt-oss-120b", fallback: { enabled: true, provider: "gemini", model: "gemini-3.5-flash", chain: [{ provider: "openai-compatible", model: "ovh/gpt-oss-120b" }] } },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (req.url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "qwen/qwen3.8-27b" }, { id: "openai/gpt-oss-120b" }, { id: "bad id" }, { id: "whisper-large-v3" }, { id: "meta-llama/llama-prompt-guard-2-22m" }] }), { status: 200 });
      return new Response(JSON.stringify({ id: "x", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "שלום" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }), {
        status: 200,
        headers: { "content-type": "application/json", "x-ratelimit-limit-requests": "1000", "x-ratelimit-remaining-requests": "999", "x-ratelimit-reset-requests": "1m26s" },
      });
    }));
    await inAgent(async (a) => {
      const p = a.providerChain()[0] as { generate: (r: unknown) => Promise<{ text: string }> };
      expect((await p.generate({ system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10 })).text).toBe("שלום");
    });
    const status = await c.json("/api/ai/chain");
    expect(status.entries.map((e: { model: string; state: string }) => `${e.model}:${e.state}`)).toEqual([
      "groq/openai/gpt-oss-120b:available",
      "gemini-3.5-flash:not_configured",
      "ovh/gpt-oss-120b:not_configured",
    ]);
    expect(status.entries[0].quota).toMatchObject({ requests: { remaining: 999, limit: 1000, window: "day" }, source: "headers" });
    const models = await c.json("/api/ai/endpoints/groq/models");
    expect(models).toEqual({ models: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"], error: null });
    expect((await c.call("/api/ai/endpoints/nope/models")).status).toBe(404);
    await c.call("/api/ai/endpoints/groq", { method: "DELETE" });
    await c.json("/api/settings", { method: "PATCH", body: { modelProvider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash", fallback: { enabled: false, chain: [] } } });
  });
});
