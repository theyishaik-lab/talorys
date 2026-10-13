import { describe, expect, it } from "vitest";
import { AppError } from "../src/api/errors";
import { FallbackProvider, fallbackOrder } from "../src/ai/fallback";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";

const req: ToolRequest = { system: "", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10, tools: [], maxIterations: 1, toolBudgetExhausted: () => true };
const unavailable = (id: string) => new AppError("AI_UNAVAILABLE", `${id}: 503 high demand`, { provider: id });

interface Probe extends AIProvider {
  calls: number;
  signals: (AbortSignal | undefined)[];
}

/** A provider whose stream is a script: events, waits (ms) and a final throw. */
function provider(id: string, modelId: string, script: (AgentEvent | number | Error)[]): Probe {
  const p: Probe = {
    id,
    modelId,
    calls: 0,
    signals: [],
    async generate() {
      p.calls++;
      const err = script.find((s) => s instanceof Error);
      if (err) throw err;
      return { text: script.flatMap((s) => (typeof s === "object" && !(s instanceof Error) && s.type === "text" ? [s.delta] : [])).join(""), usage: { inputTokens: 1, outputTokens: 1 } };
    },
    async *stream(r: GenerateRequest) {
      yield* p.generateWithTools({ ...r, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
    },
    async *generateWithTools(r: ToolRequest): AsyncIterable<AgentEvent> {
      p.calls++;
      p.signals.push(r.signal);
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

async function collect(p: AIProvider, r: ToolRequest = req): Promise<{ events: AgentEvent[]; error: unknown }> {
  const events: AgentEvent[] = [];
  try {
    for await (const e of p.generateWithTools(r)) events.push(e);
    return { events, error: null };
  } catch (error) {
    return { events, error };
  }
}
const text = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
const providers = (events: AgentEvent[]) => events.flatMap((e) => (e.type === "provider" ? [e.model] : []));

describe("fallback chain", () => {
  it("A 503, B 503, C answers — reports only the model that answered", async () => {
    const a = provider("gemini", "gemini-3.8-flash", [unavailable("gemini")]);
    const b = provider("gemini", "gemini-3.5-flash", [unavailable("gemini")]);
    const c = provider("openrouter", "x/y:free", [{ type: "text", delta: "שלום" }, { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } }]);
    const hops: string[] = [];
    const { events, error } = await collect(new FallbackProvider([a, b, c], (_e, from, to) => hops.push(`${from.modelId}>${to.modelId}`), 50));
    expect(error).toBeNull();
    expect(text(events)).toBe("שלום");
    expect(providers(events)).toEqual(["x/y:free"]);
    expect(events[0]).toMatchObject({ type: "provider", provider: "openrouter", model: "x/y:free" });
    expect(hops).toEqual(["gemini-3.8-flash>gemini-3.5-flash", "gemini-3.5-flash>x/y:free"]);
    expect([a.calls, b.calls, c.calls]).toEqual([1, 1, 1]);
  });

  it("times out each silent candidate in turn and cancels it", async () => {
    const a = provider("gemini", "a", [5_000, { type: "text", delta: "late a" }]);
    const b = provider("gemini", "b", [5_000, { type: "text", delta: "late b" }]);
    const c = provider("openrouter", "c", [{ type: "text", delta: "c" }]);
    const errors: AppError[] = [];
    const started = Date.now();
    const { events, error } = await collect(new FallbackProvider([a, b, c], (e) => errors.push(e), 30));
    expect(error).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(text(events)).toBe("c");
    expect(a.signals[0]?.aborted).toBe(true);
    expect(b.signals[0]?.aborted).toBe(true);
    expect(errors.map((e) => e.code)).toEqual(["AI_UNAVAILABLE", "AI_UNAVAILABLE"]);
    expect(errors[1]?.message).toContain("b");
  });

  it("a usage-only or provider-metadata event does not commit the turn nor stop the watchdog", async () => {
    const a = provider("gemini", "a", [{ type: "usage", usage: { inputTokens: 3, outputTokens: 0 } }, { type: "provider", provider: "gemini", model: "inner" }, unavailable("gemini")]);
    const b = provider("gemini", "b", [{ type: "usage", usage: { inputTokens: 2, outputTokens: 0 } }, 5_000, { type: "text", delta: "late" }]);
    const c = provider("openrouter", "c", [{ type: "text", delta: "ok" }]);
    const { events, error } = await collect(new FallbackProvider([a, b, c], undefined, 30));
    expect(error).toBeNull();
    expect(text(events)).toBe("ok");
    // The spent tokens are still reported; the failed candidates' switch reports are not.
    expect(events.filter((e) => e.type === "usage")).toHaveLength(2);
    expect(providers(events)).toEqual(["c"]);
  });

  it("never retries after text has streamed", async () => {
    const a = provider("gemini", "a", [{ type: "text", delta: "half" }, unavailable("gemini")]);
    const b = provider("openrouter", "b", [{ type: "text", delta: "again" }]);
    const { events, error } = await collect(new FallbackProvider([a, b], undefined, 30));
    expect(error).toMatchObject({ code: "AI_UNAVAILABLE" });
    expect(text(events)).toBe("half");
    expect(b.calls).toBe(0);
  });

  it("never retries after a tool started (its effect may have happened), even if later silent", async () => {
    const a = provider("gemini", "a", [{ type: "tool-start", id: "t1", name: "send_email", input: {} }, 200, unavailable("gemini")]);
    const b = provider("openrouter", "b", [{ type: "text", delta: "again" }]);
    const { events, error } = await collect(new FallbackProvider([a, b], undefined, 30));
    expect(error).toMatchObject({ code: "AI_UNAVAILABLE" });
    expect(events).toEqual([{ type: "tool-start", id: "t1", name: "send_email", input: {} }]);
    expect(b.calls).toBe(0);
  });

  it("stops the chain when the turn is cancelled, and the last candidate's failure is the turn's error", async () => {
    const controller = new AbortController();
    const a = provider("gemini", "a", [5_000]);
    const b = provider("openrouter", "b", [{ type: "text", delta: "b" }]);
    setTimeout(() => controller.abort(), 20);
    const { events } = await collect(new FallbackProvider([a, b], undefined, 1_000), { ...req, signal: controller.signal });
    expect(events).toEqual([]);
    expect(b.calls).toBe(0);
    expect(a.signals[0]?.aborted).toBe(true);

    const already = new AbortController();
    already.abort();
    const a2 = provider("gemini", "a", [unavailable("gemini")]);
    const b2 = provider("openrouter", "b", [{ type: "text", delta: "b" }]);
    await collect(new FallbackProvider([a2, b2], undefined, 30), { ...req, signal: already.signal });
    expect(b2.calls).toBe(0);

    const last = await collect(new FallbackProvider([provider("gemini", "a", [unavailable("gemini")]), provider("gemini", "b", [new AppError("AI_QUOTA_EXHAUSTED", "spent")])], undefined, 30));
    expect(last.error).toMatchObject({ code: "AI_QUOTA_EXHAUSTED" });
  });

  it("does not move on for errors that are not fallback reasons", async () => {
    const a = provider("gemini", "a", [new AppError("AI_LIMIT_REACHED", "daily cap")]);
    const b = provider("openrouter", "b", [{ type: "text", delta: "b" }]);
    const { error } = await collect(new FallbackProvider([a, b], undefined, 30));
    expect(error).toMatchObject({ code: "AI_LIMIT_REACHED" });
    expect(b.calls).toBe(0);
  });

  it("lets the last candidate answer slowly (no watchdog when nothing is behind it)", async () => {
    const a = provider("gemini", "a", [unavailable("gemini")]);
    const b = provider("openrouter", "b", [80, { type: "text", delta: "slow but fine" }]);
    const { events, error } = await collect(new FallbackProvider([a, b], undefined, 30));
    expect(error).toBeNull();
    expect(text(events)).toBe("slow but fine");
  });

  it("generate() walks the chain too", async () => {
    const p = new FallbackProvider([provider("gemini", "a", [unavailable("gemini")]), provider("gemini", "b", [unavailable("gemini")]), provider("openrouter", "c", [{ type: "text", delta: "c" }])]);
    expect((await p.generate(req)).text).toBe("c");
  });
});

describe("fallback order", () => {
  const primary = { provider: "gemini", model: "gemini-3.8-flash" };
  it("is primary, selected backup, then the chain — duplicates dropped", () => {
    const order = fallbackOrder(primary, {
      enabled: true,
      provider: "gemini",
      model: "gemini-3.5-flash-lite",
      chain: [{ provider: "gemini", model: "gemini-3.8-flash" }, { provider: "openrouter", model: "x/y:free" }, { provider: "gemini", model: "gemini-3.5-flash-lite" }, { provider: "openrouter", model: "x/y:free" }],
    });
    expect(order).toEqual([primary, { provider: "gemini", model: "gemini-3.5-flash-lite" }, { provider: "openrouter", model: "x/y:free" }]);
  });
  it("keeps the chain when the selected backup equals the primary, and ignores everything when disabled", () => {
    expect(fallbackOrder(primary, { enabled: true, ...primary, chain: [{ provider: "openrouter", model: "x/y:free" }] })).toEqual([primary, { provider: "openrouter", model: "x/y:free" }]);
    expect(fallbackOrder(primary, { enabled: false, provider: "openrouter", model: "x/y:free", chain: [{ provider: "openrouter", model: "z:free" }] })).toEqual([primary]);
    // Settings stored before the chain existed.
    expect(fallbackOrder(primary, { enabled: true, provider: "openrouter", model: "x/y:free" })).toEqual([primary, { provider: "openrouter", model: "x/y:free" }]);
  });
});
