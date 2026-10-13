import { describe, expect, it } from "vitest";
import { formatAttempts } from "@talorys/shared";
import { AppError } from "../src/api/errors";
import { cooldownFor, ModelCooldowns, nextUtcMidnight } from "../src/ai/cooldown";
import { FallbackProvider } from "../src/ai/fallback";
import { modelCaps, outputFor, promptBudgetFor } from "../src/ai/model-caps";
import { classifyAiError, quotaHints, type AgentEvent, type AIProvider, type ToolRequest } from "../src/ai/provider";
import { SubrequestGuard, subrequestLimitFrom } from "../src/agent/runner";

const req: ToolRequest = { system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10, tools: [], maxIterations: 1, toolBudgetExhausted: () => true };

/** An AI SDK-like error: status, response headers and body, as APICallError carries them. */
function apiError(message: string, statusCode: number, extra: { headers?: Record<string, string>; body?: string } = {}): Error {
  return Object.assign(new Error(message), { statusCode, responseHeaders: extra.headers ?? {}, responseBody: extra.body ?? "" });
}

const GEMINI_DAILY = apiError(
  "You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3.8-flash Please retry in 4h26m27.907582237s.",
  429,
  { body: '{"error":{"status":"RESOURCE_EXHAUSTED","details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},{"retryDelay":"15987s"}]}}' },
);
const GEMINI_MINUTE = apiError("You exceeded your current quota. Quota exceeded for metric: …requests, limit: 5", 429, {
  body: '{"error":{"details":[{"violations":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}]},{"retryDelay":"37s"}]}}',
});
const NOW = Date.parse("2026-10-13T19:30:00Z");

describe("quota hints from provider errors", () => {
  it("reads Gemini's daily quota and its retry delay", () => {
    expect(quotaHints(GEMINI_DAILY, "gemini")).toEqual({ retry_after_s: 4 * 3600 + 26 * 60 + 28, quota_window: "day" });
    const e = classifyAiError(GEMINI_DAILY, "gemini", "gemini-3.8-flash");
    expect(e.code).toBe("AI_QUOTA_EXHAUSTED");
    expect(e.details).toMatchObject({ reason: "quota", quota_window: "day", retry_after_s: 15988 });
  });

  it("reads a per-minute limit and Gemini's retryDelay", () => {
    expect(quotaHints(GEMINI_MINUTE, "gemini")).toEqual({ retry_after_s: 37, quota_window: "minute" });
  });

  it("knows OpenRouter's free allowance is the account's, and reads X-RateLimit-Reset", () => {
    const reset = Date.now() + 3_600_000;
    const e = apiError("Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day", 429, { headers: { "X-RateLimit-Reset": String(reset) } });
    const h = quotaHints(e, "openrouter");
    expect(h.quota_window).toBe("day");
    expect(h.scope).toBe("provider");
    expect(h.retry_after_s).toBeGreaterThan(3590);
    expect(h.retry_after_s).toBeLessThanOrEqual(3600);
  });

  it("knows Workers AI's neurons are the account's", () => {
    const e = classifyAiError(new Error("AiError: you have used up your daily free allocation of 10,000 neurons (4006)"), "workers-ai", "@cf/google/gemma-4-26b-a4b-it");
    expect(e.code).toBe("AI_QUOTA_EXHAUSTED");
    expect(e.details).toMatchObject({ reason: "quota", quota_window: "day", scope: "provider" });
  });

  it("an upstream rate limit is a short one", () => {
    expect(quotaHints(apiError("google/gemma-4-31b-it:free is temporarily rate-limited upstream. Please retry shortly", 429), "openrouter").quota_window).toBe("minute");
  });
});

describe("cooldownFor", () => {
  const quota = (details: object) => new AppError("AI_QUOTA_EXHAUSTED", "quota", { reason: "quota", ...details });
  it("pauses a spent daily quota until the provider's reset, or the next 00:00 UTC", () => {
    expect(cooldownFor(quota({ quota_window: "day", retry_after_s: 3600 }), NOW)?.ms).toBe(3_600_000);
    expect(cooldownFor(quota({ quota_window: "day" }), NOW)?.ms).toBe(nextUtcMidnight(NOW) - NOW);
    expect(nextUtcMidnight(NOW)).toBe(Date.parse("2026-10-14T00:00:00Z"));
    // Never more than a day, never less than 10 minutes.
    expect(cooldownFor(quota({ quota_window: "day", retry_after_s: 9 * 86400 }), NOW)?.ms).toBe(86_400_000);
    expect(cooldownFor(quota({ quota_window: "day", retry_after_s: 5 }), NOW)?.ms).toBe(600_000);
    expect(cooldownFor(quota({ quota_window: "day", scope: "provider" }), NOW)?.scope).toBe("provider");
  });

  it("pauses a per-minute limit briefly", () => {
    expect(cooldownFor(quota({ quota_window: "minute", retry_after_s: 37 }), NOW)?.ms).toBe(37_000);
    expect(cooldownFor(quota({}), NOW)?.ms).toBe(60_000);
  });

  it("backs off overload and silence, doubling up to 30 minutes", () => {
    const busy = new AppError("AI_UNAVAILABLE", "503", { reason: "overloaded", status: 503 });
    expect([1, 2, 3, 6, 9].map((n) => cooldownFor(busy, NOW, n)?.ms)).toEqual([60_000, 120_000, 240_000, 1_800_000, 1_800_000]);
    const silent = new AppError("AI_UNAVAILABLE", "No answer from x within 15 s; switched to the next model.", { reason: "timeout", timeout_s: 15 });
    expect(cooldownFor(silent, NOW, 1)?.ms).toBe(300_000);
    expect(cooldownFor(silent, NOW, 2)?.ms).toBe(600_000);
  });
});

function memoryStore() {
  const data = new Map<string, string>();
  return {
    getJson: <T>(k: string) => (data.has(k) ? (JSON.parse(data.get(k) as string) as T) : null),
    setJson: (k: string, v: unknown) => void data.set(k, JSON.stringify(v)),
  };
}

describe("ModelCooldowns", () => {
  it("pauses a model, covers a whole provider on an account limit, and ends on success or time", () => {
    let now = NOW;
    const c = new ModelCooldowns(memoryStore(), () => now);
    c.failed("gemini", "gemini-3.8-flash", new AppError("AI_UNAVAILABLE", "503", { reason: "overloaded" }));
    expect(c.active("gemini", "gemini-3.8-flash")?.reason).toBe("overloaded");
    expect(c.active("gemini", "gemini-3.5-flash")).toBeNull();
    c.failed("openrouter", "a:free", new AppError("AI_QUOTA_EXHAUSTED", "free-models-per-day", { reason: "quota", quota_window: "day", scope: "provider" }));
    expect(c.active("openrouter", "b:free")?.until).toBe("2026-10-14T00:00:00.000Z");
    expect(c.list().map((e) => `${e.provider}:${e.model ?? "*"}`)).toEqual(["gemini:gemini-3.8-flash", "openrouter:a:free", "openrouter:*"]);
    c.succeeded("openrouter", "b:free");
    expect(c.active("openrouter", "b:free")).toBeNull();
    now += 61_000;
    expect(c.active("gemini", "gemini-3.8-flash")).toBeNull();
    // Failing again soon after: the pause doubles.
    const again = c.failed("gemini", "gemini-3.8-flash", new AppError("AI_UNAVAILABLE", "503", { reason: "overloaded" }));
    expect(again?.strikes).toBe(2);
    expect(Date.parse(again!.until) - now).toBe(120_000);
    c.clear();
    expect(c.list()).toEqual([]);
  });
});

/** A provider that fails with `error` before any content, or answers "ok from <model>". */
function scripted(id: string, modelId: string, error?: Error): AIProvider & { calls: number } {
  const p = {
    id,
    modelId,
    calls: 0,
    async generate() {
      p.calls++;
      if (error) throw error;
      return { text: `ok from ${modelId}`, usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *stream() {},
    async *generateWithTools(): AsyncIterable<AgentEvent> {
      p.calls++;
      if (error) throw error;
      yield { type: "text", delta: `ok from ${modelId}` };
    },
  };
  return p;
}

async function run(p: AIProvider): Promise<{ events: AgentEvent[]; error: unknown }> {
  const events: AgentEvent[] = [];
  try {
    for await (const e of p.generateWithTools(req)) events.push(e);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

describe("FallbackProvider with cooldowns", () => {
  const daily = () => new AppError("AI_QUOTA_EXHAUSTED", "Google Gemini has no quota left", { reason: "quota", quota_window: "day", status: 429 });
  const hooks = (c: ModelCooldowns) => ({
    active: (p: string, m: string) => c.active(p, m),
    failed: (p: string, m: string, e: AppError) => void c.failed(p, m, e),
    succeeded: (p: string, m: string) => c.succeeded(p, m),
  });

  it("skips a model whose daily quota is spent instead of asking it on every message", async () => {
    const cooldowns = new ModelCooldowns(memoryStore(), () => NOW);
    const best = scripted("gemini", "gemini-3.8-flash", daily());
    const next = scripted("openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free");
    const chain = () => new FallbackProvider([best, next], undefined, 1000, hooks(cooldowns));

    const first = await run(chain());
    expect(first.error).toBeNull();
    expect(best.calls).toBe(1);
    expect(cooldowns.active("gemini", "gemini-3.8-flash")?.reason).toBe("quota");

    const second = await run(chain());
    expect(second.error).toBeNull();
    expect(best.calls).toBe(1); // not asked again
    expect(next.calls).toBe(2);
    // The answer is still announced as a backup's, naming the paused model.
    const announce = second.events.find((e) => e.type === "provider");
    expect(announce).toMatchObject({ type: "provider", model: "nvidia/nemotron-3-ultra-550b-a55b:free" });
    const attempts = announce?.type === "provider" ? (announce.attempts ?? []) : [];
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ provider: "gemini", model: "gemini-3.8-flash", reason: "quota", skipped: true });
    expect(formatAttempts(attempts, "he")).toBe("Gemini 3.8 Flash (Google): מכסה (בהשהיה)");
  });

  it("tries every model when all of them are paused, and a success ends the pause", async () => {
    const cooldowns = new ModelCooldowns(memoryStore(), () => NOW);
    cooldowns.failed("gemini", "a", daily());
    cooldowns.failed("gemini", "b", daily());
    const a = scripted("gemini", "a", daily());
    const b = scripted("gemini", "b");
    const { error, events } = await run(new FallbackProvider([a, b], undefined, 1000, hooks(cooldowns)));
    expect(error).toBeNull();
    expect(a.calls + b.calls).toBe(2);
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(cooldowns.active("gemini", "b")).toBeNull();
  });

  it("pauses the last model too, and the turn's error lists the paused ones after the tried ones", async () => {
    const cooldowns = new ModelCooldowns(memoryStore(), () => NOW);
    cooldowns.failed("gemini", "a", daily());
    const a = scripted("gemini", "a");
    const b = scripted("gemini", "b", daily());
    const { error } = await run(new FallbackProvider([b, a], undefined, 1000, hooks(cooldowns)));
    expect(error).toBeInstanceOf(AppError);
    const attempts = ((error as AppError).details as { attempts: { model: string; skipped?: boolean }[] }).attempts;
    expect(attempts.map((x) => `${x.model}${x.skipped ? " (skipped)" : ""}`)).toEqual(["b", "a (skipped)"]);
    expect((error as AppError).details).toMatchObject({ model: "b" });
    expect(cooldowns.active("gemini", "b")?.reason).toBe("quota");
  });

  it("generate() (summaries) skips paused models too", async () => {
    const cooldowns = new ModelCooldowns(memoryStore(), () => NOW);
    cooldowns.failed("gemini", "a", daily());
    const a = scripted("gemini", "a");
    const b = scripted("gemini", "b");
    const out = await new FallbackProvider([a, b], undefined, 1000, hooks(cooldowns)).generate(req);
    expect(out.text).toBe("ok from b");
    expect(a.calls).toBe(0);
  });

  it("a cancelled turn pauses nothing", async () => {
    const cooldowns = new ModelCooldowns(memoryStore(), () => NOW);
    const controller = new AbortController();
    controller.abort();
    const a = scripted("gemini", "a", new AppError("AI_UNAVAILABLE", "The response was cancelled."));
    const b = scripted("gemini", "b");
    const p = new FallbackProvider([a, b], undefined, 1000, hooks(cooldowns));
    await expect(
      (async () => {
        for await (const _ of p.generateWithTools({ ...req, signal: controller.signal })) {
          // drain
        }
      })(),
    ).rejects.toBeInstanceOf(AppError);
    expect(cooldowns.list()).toEqual([]);
  });
});

describe("per-model caps", () => {
  it("clamps output to the model and sizes the prompt for the smallest window in the chain", () => {
    expect(modelCaps("gemini", "gemini-3.8-flash")).toEqual({ context: 1_048_576, maxOutput: 65_536 });
    expect(modelCaps("gemini", "gemma-4-26b-a4b-it").maxOutput).toBe(32_768);
    expect(modelCaps("workers-ai", "@cf/openai/gpt-oss-120b").context).toBe(128_000);
    expect(modelCaps("openrouter", "unknown/model:free")).toEqual({ context: 131_072, maxOutput: 16_384 });
    expect(outputFor(modelCaps("gemini", "gemini-3.5-flash"), 262_144)).toBe(65_536);
    expect(outputFor(modelCaps("gemini", "gemini-3.5-flash"), 1024)).toBe(1024);
    const big = { ...scripted("gemini", "x"), promptBudget: (o: number) => promptBudgetFor(modelCaps("gemini", "gemini-3.8-flash"), o) };
    const small = { ...scripted("workers-ai", "y"), promptBudget: (o: number) => promptBudgetFor(modelCaps("workers-ai", "@cf/openai/gpt-oss-120b"), o) };
    expect(new FallbackProvider([big, small]).promptBudget(262_144)).toBe(Math.floor((128_000 - 32_000) * 0.5));
  });
});

describe("SubrequestGuard (Workers Free: 50 subrequests per invocation)", () => {
  it("asks for the final answer before the wall and stops one step later", () => {
    const g = new SubrequestGuard(50);
    expect(g.mustAnswer(0)).toBe(false);
    let calls = 0;
    let steps = 1;
    while (g.nextStep(calls)) {
      steps++;
      if (!g.mustAnswer(calls)) calls++;
    }
    // Model steps + tool calls never pass the limit minus the reserve for fallback hops and the like.
    expect(steps + calls).toBeLessThanOrEqual(39);
    expect(g.mustAnswer(calls)).toBe(true);
  });

  it("reads TALORYS_SUBREQUEST_LIMIT (Paid plans allow 10,000)", () => {
    expect(subrequestLimitFrom(undefined)).toBe(50);
    expect(subrequestLimitFrom("10000")).toBe(10000);
    expect(subrequestLimitFrom("nonsense")).toBe(50);
    expect(subrequestLimitFrom("3")).toBe(50);
  });
});
