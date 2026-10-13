import { describe, expect, it } from "vitest";
import { type AiAttempt, attemptReason, formatAttempts, modelDisplayName, modelLabel, parseAttribution } from "@talorys/shared";
import { AppError } from "../src/api/errors";
import { AgentRunner } from "../src/agent/runner";
import { FallbackProvider } from "../src/ai/fallback";
import { attributionFromError, reasonOf } from "../src/ai/attribution";
import { type AgentEvent, type AIProvider, classifyAiError, type GenerateRequest, type ToolRequest } from "../src/ai/provider";
import { inAgent } from "./helpers";

/**
 * Yishai, Oct 13, 2026: "when I get an error from a model or provider, I want an indication of
 * which model or provider it came from". Every model failure names the model; a failed chain lists
 * each model it tried and why; a backup's answer says which model actually answered.
 */

const req: ToolRequest = { system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10, tools: [], maxIterations: 1, toolBudgetExhausted: () => true };

function scripted(id: string, modelId: string, script: (AgentEvent | number | Error)[]): AIProvider {
  const p: AIProvider = {
    id,
    modelId,
    async generate() {
      const err = script.find((s) => s instanceof Error);
      if (err) throw err;
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *stream(r: GenerateRequest) {
      yield* p.generateWithTools({ ...r, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
    },
    async *generateWithTools(r: ToolRequest): AsyncIterable<AgentEvent> {
      for (const step of script) {
        if (typeof step === "number") {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, step);
            r.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new Error("AbortError: The operation was aborted"));
            });
          });
        } else if (step instanceof Error) throw step;
        else yield step;
      }
    },
  };
  return p;
}

/** What the real classifier makes of a provider's HTTP failure. */
const http = (status: number, body: string, provider: "gemini" | "openrouter" | "workers-ai", model: string) =>
  classifyAiError(Object.assign(new Error(`${status} ${body}`), { statusCode: status }), provider, model);

async function collect(p: AIProvider): Promise<{ events: AgentEvent[]; error: unknown }> {
  const events: AgentEvent[] = [];
  try {
    for await (const e of p.generateWithTools(req)) events.push(e);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}

describe("model labels", () => {
  it("reads model ids as names", () => {
    expect(modelLabel("gemini-3.5-flash-lite")).toBe("Gemini 3.5 Flash Lite");
    expect(modelLabel("gemini-3.8-flash")).toBe("Gemini 3.8 Flash");
    expect(modelLabel("nvidia/nemotron-3-super-120b-a12b:free")).toBe("Nemotron 3 Super 120B A12B");
    expect(modelLabel("@cf/google/gemma-4-26b-a4b-it")).toBe("Gemma 4 26B A4B");
    expect(modelLabel("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBe("Llama 3.3 70B");
    expect(modelDisplayName({ provider: "workers-ai", model: "@cf/google/gemma-4-26b-a4b-it" })).toBe("Gemma 4 26B A4B (Workers AI)");
    expect(modelDisplayName({ provider: "openrouter", model: "x/y:free" })).toBe("Y (OpenRouter)");
  });

  it("gives each failure a short reason word in Hebrew and English", () => {
    expect(attemptReason({ reason: "overloaded", status: 503 }, "he")).toBe("עומס 503");
    expect(attemptReason({ reason: "quota", status: 429 }, "he")).toBe("מכסה");
    expect(attemptReason({ reason: "timeout", timeout_s: 15 }, "he")).toBe("לא הגיב 15 ש׳");
    expect(attemptReason({ reason: "not_configured" }, "he")).toBe("לא מוגדר");
    expect(attemptReason({ reason: "overloaded", status: 503 })).toBe("overloaded 503");
    expect(attemptReason({ reason: "timeout", timeout_s: 15 })).toBe("no answer in 15 s");
  });
});

describe("the classifier records which model failed and why", () => {
  it("503 high demand → overloaded, 429 → quota, 401 → bad key, 404 → no model", () => {
    const e = http(503, "This model is currently experiencing high demand", "gemini", "gemini-3.5-flash");
    expect(e.code).toBe("AI_UNAVAILABLE");
    expect(e.details).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash", status: 503, reason: "overloaded" });
    expect(reasonOf(http(429, "Rate limit exceeded: free-models-per-day", "openrouter", "x:free"))).toBe("quota");
    expect(reasonOf(http(401, "No auth credentials found", "openrouter", "x:free"))).toBe("bad_key");
    expect(reasonOf(http(404, "model not found", "gemini", "gemini-9"))).toBe("no_model");
    expect(reasonOf(classifyAiError(new Error("4006: you have used up your daily free allocation of 10,000 neurons"), "workers-ai", "@cf/x"))).toBe("quota");
  });

  it("derives a reason for errors thrown without one", () => {
    expect(reasonOf(new AppError("NOT_CONFIGURED", "OpenRouter needs an API key."))).toBe("not_configured");
    expect(reasonOf(new AppError("AI_UNAVAILABLE", "No answer from a within 15 s; switched to the next model."))).toBe("timeout");
  });
});

describe("a failed chain lists every model it tried", () => {
  it("A 503, B 503, C quota: one error naming all three, in order, with codes and statuses", async () => {
    const a = scripted("gemini", "gemini-3.8-flash", [http(503, "high demand", "gemini", "gemini-3.8-flash")]);
    const b = scripted("gemini", "gemini-3.5-flash-lite", [http(503, "high demand", "gemini", "gemini-3.5-flash-lite")]);
    const c = scripted("openrouter", "meta-llama/llama-3.3-70b-instruct:free", [http(429, "Rate limit exceeded", "openrouter", "meta-llama/llama-3.3-70b-instruct:free")]);
    const { error } = await collect(new FallbackProvider([a, b, c], undefined, 50));
    expect(error).toBeInstanceOf(AppError);
    const e = error as AppError;
    expect(e.code).toBe("AI_QUOTA_EXHAUSTED");
    const attempts = (e.details as { attempts: AiAttempt[] }).attempts;
    expect(attempts.map((x) => [x.provider, x.model, x.code, x.reason, x.status])).toEqual([
      ["gemini", "gemini-3.8-flash", "AI_UNAVAILABLE", "overloaded", 503],
      ["gemini", "gemini-3.5-flash-lite", "AI_UNAVAILABLE", "overloaded", 503],
      ["openrouter", "meta-llama/llama-3.3-70b-instruct:free", "AI_QUOTA_EXHAUSTED", "quota", 429],
    ]);
    // The last one tried stays at the top level too (older web clients read details.provider).
    expect(e.details).toMatchObject({ provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free", status: 429, reason: "quota" });
    expect(formatAttempts(attempts, "he")).toBe("Gemini 3.8 Flash (Google): עומס 503 · Gemini 3.5 Flash Lite (Google): עומס 503 · Llama 3.3 70B (OpenRouter): מכסה");
    expect(e.message).toBe("None of the models answered: Gemini 3.8 Flash (Google): overloaded 503 · Gemini 3.5 Flash Lite (Google): overloaded 503 · Llama 3.3 70B (OpenRouter): quota.");
  });

  it("records a silent model as a 15 s timeout and a missing key as not configured", async () => {
    const a = scripted("gemini", "a", [5_000, { type: "text", delta: "late" }]);
    const b = scripted("openrouter", "b", [new AppError("NOT_CONFIGURED", "OpenRouter needs an API key.", { provider: "openrouter", model: "b", reason: "not_configured" })]);
    const c = scripted("workers-ai", "c", [http(503, "capacity", "workers-ai", "c")]);
    const { error } = await collect(new FallbackProvider([a, b, c], undefined, 30));
    const attempts = ((error as AppError).details as { attempts: AiAttempt[] }).attempts;
    expect(attempts.map((x) => x.reason)).toEqual(["timeout", "not_configured", "overloaded"]);
    expect(attempts[0]).toMatchObject({ provider: "gemini", model: "a", timeout_s: 0 });
  });

  it("a backup that fails after it started answering is the last attempt, after the ones before it", async () => {
    const a = scripted("gemini", "a", [http(503, "high demand", "gemini", "a")]);
    const b = scripted("openrouter", "b", [{ type: "text", delta: "half" }, http(502, "upstream", "openrouter", "b")]);
    const { events, error } = await collect(new FallbackProvider([a, b], undefined, 50));
    expect(events.some((e) => e.type === "text")).toBe(true);
    const attempts = ((error as AppError).details as { attempts: AiAttempt[] }).attempts;
    expect(attempts.map((x) => `${x.model}:${x.reason}:${x.status}`)).toEqual(["a:overloaded:503", "b:overloaded:502"]);
  });

  it("a backup that answers is announced with the failures before it", async () => {
    const a = scripted("gemini", "gemini-3.8-flash", [http(503, "high demand", "gemini", "gemini-3.8-flash")]);
    const b = scripted("openrouter", "nvidia/nemotron-3-super-120b-a12b:free", [{ type: "text", delta: "שלום" }]);
    const { events, error } = await collect(new FallbackProvider([a, b], undefined, 50));
    expect(error).toBeNull();
    expect(events[0]).toMatchObject({ type: "provider", provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free" });
    const attempts = (events[0] as { attempts: AiAttempt[] }).attempts;
    expect(attempts.map((x) => `${x.model}:${x.reason}`)).toEqual(["gemini-3.8-flash:overloaded"]);
  });

  it("generate() (summaries) carries the same attempts list", async () => {
    const a = scripted("gemini", "a", [http(503, "x", "gemini", "a")]);
    const b = scripted("gemini", "b", [http(429, "x", "gemini", "b")]);
    const err = await new FallbackProvider([a, b], undefined, 50).generate(req).catch((e) => e);
    expect(((err as AppError).details as { attempts: AiAttempt[] }).attempts.map((x) => x.model)).toEqual(["a", "b"]);
  });

  it("a single model's own error is attributed to it", () => {
    const ai = attributionFromError(http(503, "high demand", "gemini", "gemini-3.5-flash"), { provider: "gemini", model: "gemini-3.5-flash" });
    expect(ai).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash", fallback: false });
    expect(ai.attempts).toHaveLength(1);
  });
});

describe("chat turns carry the attribution to the client and the saved message", () => {
  async function turn(provider: AIProvider) {
    let out: { events: any[]; saved: any } = { events: [], saved: null };
    await inAgent(async (agent) => {
      const events: any[] = [];
      for await (const e of new AgentRunner(agent.services, provider).chat({ message: "hi", signal: new AbortController().signal })) events.push(e);
      const done = events.find((e) => e.type === "done");
      const saved = agent.services.conversations.messages(done.message.conversation_id).find((m) => m.id === done.message.id);
      agent.services.conversations.delete(done.message.conversation_id);
      out = { events, saved };
    });
    return out;
  }

  it("whole chain fails: the error event names the last model, lists every attempt, and the saved reply keeps them", async () => {
    const chain = new FallbackProvider(
      [
        scripted("gemini", "gemini-3.8-flash", [http(503, "high demand", "gemini", "gemini-3.8-flash")]),
        scripted("openrouter", "x/llama:free", [http(429, "rate limit", "openrouter", "x/llama:free")]),
      ],
      undefined,
      50,
    );
    const { events, saved } = await turn(chain);
    const error = events.find((e) => e.type === "error");
    expect(error).toMatchObject({ code: "AI_QUOTA_EXHAUSTED", provider: "openrouter", model: "x/llama:free", status: 429, reason: "quota" });
    expect(error.attempts.map((a: AiAttempt) => a.model)).toEqual(["gemini-3.8-flash", "x/llama:free"]);
    expect(error.details).toMatchObject({ provider: "openrouter" });
    expect(saved.status).toBe("error");
    expect(saved.error_code).toBe("AI_QUOTA_EXHAUSTED");
    expect(saved.ai).toMatchObject({ provider: "openrouter", model: "x/llama:free", fallback: true });
    expect(saved.ai.attempts.map((a: AiAttempt) => `${a.model}:${a.reason}`)).toEqual(["gemini-3.8-flash:overloaded", "x/llama:free:quota"]);
  });

  it("a backup answers: a model event before its text, and the saved reply names it", async () => {
    const chain = new FallbackProvider(
      [scripted("gemini", "gemini-3.8-flash", [http(503, "high demand", "gemini", "gemini-3.8-flash")]), scripted("openrouter", "nvidia/nemotron:free", [{ type: "text", delta: "שלום" }])],
      undefined,
      50,
    );
    const { events, saved } = await turn(chain);
    const types = events.map((e) => e.type);
    expect(types.indexOf("model")).toBeLessThan(types.indexOf("text"));
    expect(events.find((e) => e.type === "model")).toMatchObject({ provider: "openrouter", model: "nvidia/nemotron:free", fallback: true });
    expect(saved.status).toBe("complete");
    expect(saved.ai).toMatchObject({ provider: "openrouter", model: "nvidia/nemotron:free", fallback: true });
    expect(saved.ai.attempts).toHaveLength(1);
    expect(events.find((e) => e.type === "done").message.ai).toMatchObject({ model: "nvidia/nemotron:free", fallback: true });
  });

  it("the chosen model answers: no model event, the reply records it with fallback false", async () => {
    const { events, saved } = await turn(scripted("gemini", "gemini-3.5-flash", [{ type: "text", delta: "hi" }]));
    expect(events.some((e) => e.type === "model")).toBe(false);
    expect(saved.ai).toEqual({ provider: "gemini", model: "gemini-3.5-flash", fallback: false, attempts: [] });
  });

  it("an older stored message without attribution still reads, and junk JSON is ignored", () => {
    expect(parseAttribution(null)).toBeNull();
    expect(parseAttribution("{not json")).toBeNull();
    expect(parseAttribution({ provider: "gemini" })).toBeNull();
  });
});
