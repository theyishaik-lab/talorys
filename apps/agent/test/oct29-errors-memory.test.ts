import { describe, expect, it } from "vitest";
import { cooldownFor } from "../src/ai/cooldown";
import { keepsReasoningContent, withoutReasoningContent } from "../src/ai/openai-compatible";
import { classifyAiError } from "../src/ai/provider";
import { AUTO_MEMORY_RULE, buildSystemPrompt, EXPLICIT_MEMORY_RULE } from "../src/agent/prompt";
import { memoryTools } from "../src/tools/memories";

/** Production samples from the agent's error log, Oct 22-29, 2026. */
const WORKERS_PAID_ONLY = new Error(
  "AI_APICallError: 5035: Model @cf/zai-org/glm-5.3 is not available on the Workers Free plan. Upgrade to access this model: https://dash.cloudflare.com/?to=/:account/workers/plans",
);

describe("Workers AI models that need the paid plan (5035)", () => {
  it("are classified as no_model with a message that says what to do", () => {
    const e = classifyAiError(WORKERS_PAID_ONLY, "workers-ai", "@cf/zai-org/glm-5.3");
    expect(e.code).toBe("AI_UNAVAILABLE");
    expect((e.details as { reason?: string }).reason).toBe("no_model");
    expect(e.message).toContain("Workers Paid plan");
    expect(e.message).toContain("@cf/zai-org/glm-5.3");
  });

  it("are paused for hours, not retried on every turn", () => {
    const e = classifyAiError(WORKERS_PAID_ONLY, "workers-ai", "@cf/zai-org/glm-5.3");
    const pause = cooldownFor(e, Date.now());
    expect(pause?.ms).toBeGreaterThanOrEqual(60 * 60_000);
    expect(pause?.scope).toBe("model");
  });

  it("does not turn the daily allocation (4006) into a plan error", () => {
    const e = classifyAiError(new Error("4006: you have used up your daily free allocation of 10,000 neurons"), "workers-ai", "@cf/x");
    expect((e.details as { reason?: string }).reason).toBe("quota");
  });
});

describe("reasoning_content on OpenAI-compatible endpoints", () => {
  const body = {
    model: "qwen/qwen3.8-27b",
    messages: [
      { role: "system", content: "s" },
      { role: "user", content: "check the queue" },
      { role: "assistant", content: "", reasoning_content: "thinking…", tool_calls: [{ id: "c1", type: "function", function: { name: "list_tasks", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: "[]" },
    ],
  };

  it("is removed from assistant messages before the request is sent (Groq rejects it)", async () => {
    let sent: string | undefined;
    const f = withoutReasoningContent((async (_i: unknown, init?: RequestInit) => {
      sent = init?.body as string;
      return new Response("{}");
    }) as typeof fetch);
    await f("https://api.groq.com/openai/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });
    const parsed = JSON.parse(sent!);
    expect(parsed.messages[2].reasoning_content).toBeUndefined();
    expect(parsed.messages[2].tool_calls).toHaveLength(1);
    expect(parsed.messages[3]).toEqual(body.messages[3]);
  });

  it("leaves requests without the field untouched", async () => {
    let sent: unknown;
    const plain = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
    const f = withoutReasoningContent((async (_i: unknown, init?: RequestInit) => {
      sent = init?.body;
      return new Response("{}");
    }) as typeof fetch);
    await f("https://x", { method: "POST", body: plain });
    expect(sent).toBe(plain);
  });

  it("is kept only for the endpoints that need it back", () => {
    expect(keepsReasoningContent("https://api.deepseek.com/v1")).toBe(true);
    expect(keepsReasoningContent("https://api.moonshot.ai/v1")).toBe(true);
    expect(keepsReasoningContent("https://api.groq.com/openai/v1")).toBe(false);
    expect(keepsReasoningContent("https://api.cerebras.ai/v1")).toBe(false);
  });
});

describe("learning from conversations", () => {
  const prompt = (autoMemory: boolean) =>
    buildSystemPrompt({ agentName: "Tony", timezone: "Asia/Jerusalem", now: new Date(), autoMemory, memories: [] });

  it("asks the model to call remember for lasting facts when it is on", () => {
    const p = prompt(true);
    expect(p).toContain(AUTO_MEMORY_RULE);
    expect(AUTO_MEMORY_RULE).toMatch(/call the remember tool in that same turn/);
    expect(AUTO_MEMORY_RULE).not.toMatch(/you may save/);
    expect(p).not.toContain(EXPLICIT_MEMORY_RULE);
  });

  it("keeps the explicit-only rule when it is off", () => {
    expect(prompt(false)).toContain(EXPLICIT_MEMORY_RULE);
  });

  it("the remember tool's description no longer forbids learning on its own", () => {
    const remember = memoryTools.find((t) => t.name === "remember")!;
    expect(remember.description).not.toMatch(/Only use when the owner asks/);
    expect(remember.description).toMatch(/learning from conversations/);
  });
});
