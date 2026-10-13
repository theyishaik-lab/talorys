import { describe, expect, it } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { gracefulStopText, LeakGuard, parseLeakedToolCalls } from "../src/ai/leak-guard";
import { CloudflareWorkersAIProvider, withoutLeakedMarkup } from "../src/ai/workers-ai";
import type { AgentEvent, ProviderTool } from "../src/ai/provider";

const KNOWN = new Set(["search_actions", "run_action", "connected_apps"]);

/** Exactly what glm-4.7-flash leaked to Yishai on Oct 13, 2026 (03:08 IL). */
const YISHAI_LEAK =
  "אני מנסה לחפש את הפעולה המתאימה לג'ימייל:<tool_call>search_actions<arg_key>query</arg_key><arg_value>gmail get threads</arg_value><arg_key>service</arg_key><arg_value>gmail</arg_value></tool_call>";

function feed(guard: LeakGuard, text: string, chunk = 3): string {
  let out = "";
  for (let i = 0; i < text.length; i += chunk) out += guard.push(text.slice(i, i + chunk));
  return out;
}

describe("parseLeakedToolCalls", () => {
  it("reads glm's arg_key/arg_value markup", () => {
    expect(parseLeakedToolCalls(YISHAI_LEAK, KNOWN)).toEqual([{ name: "search_actions", input: { query: "gmail get threads", service: "gmail" } }]);
  });

  it("reads JSON tool_call blocks, function tags, [TOOL_CALLS] and python_tag", () => {
    expect(parseLeakedToolCalls('<tool_call>\n{"name": "run_action", "arguments": {"action": "gmail.search_threads", "input": {"maxResults": 3}}}\n</tool_call>', KNOWN)).toEqual([
      { name: "run_action", input: { action: "gmail.search_threads", input: { maxResults: 3 } } },
    ]);
    expect(parseLeakedToolCalls('<function=connected_apps>{"service": "googledrive"}</function>', KNOWN)).toEqual([{ name: "connected_apps", input: { service: "googledrive" } }]);
    expect(parseLeakedToolCalls('[TOOL_CALLS][{"name": "connected_apps", "arguments": {}}]', KNOWN)).toEqual([{ name: "connected_apps", input: {} }]);
    expect(parseLeakedToolCalls('<|python_tag|>{"name": "search_actions", "parameters": {"query": "list files"}}', KNOWN)).toEqual([{ name: "search_actions", input: { query: "list files" } }]);
  });

  it("parses typed glm values and several calls in a row", () => {
    const text =
      "<tool_call>run_action<arg_key>action</arg_key><arg_value>gmail.fetch_emails</arg_value><arg_key>input</arg_key><arg_value>{\"maxResults\": 3}</arg_value></tool_call><tool_call>connected_apps</tool_call>";
    expect(parseLeakedToolCalls(text, KNOWN)).toEqual([
      { name: "run_action", input: { action: "gmail.fetch_emails", input: { maxResults: 3 } } },
      { name: "connected_apps", input: {} },
    ]);
  });

  it("ignores unknown tools and unparseable markup", () => {
    expect(parseLeakedToolCalls("<tool_call>delete_everything<arg_key>x</arg_key><arg_value>1</arg_value></tool_call>", KNOWN)).toEqual([]);
    expect(parseLeakedToolCalls("<tool_call>{not json", KNOWN)).toEqual([]);
    expect(parseLeakedToolCalls("no markup here", KNOWN)).toEqual([]);
  });

  it("uses the name written just before a bare arg_key", () => {
    expect(parseLeakedToolCalls("<arg_key>service</arg_key><arg_value>github</arg_value>", KNOWN, "connected_apps")).toEqual([{ name: "connected_apps", input: { service: "github" } }]);
  });
});

describe("LeakGuard", () => {
  it("hides tool-call markup even when the marker is split across deltas", () => {
    const g = new LeakGuard();
    let out = feed(g, YISHAI_LEAK, 2);
    out += g.endStep();
    expect(out).toBe("אני מנסה לחפש את הפעולה המתאימה לג'ימייל:");
    expect(g.takeLeaks().text).toContain("<tool_call>search_actions");
    expect(g.takeLeaks().text).toBe("");
  });

  it("lets ordinary angle brackets and markdown links through", () => {
    const g = new LeakGuard();
    const text = "if a < b use [the docs](https://x.example) and <b>bold</b>\n";
    expect(feed(g, text, 1) + g.endStep()).toBe(text);
  });

  it("drops a preamble repeated on every step and flags a stuck loop", () => {
    const g = new LeakGuard();
    const pre = "אני מנסה לחפש את הפעולה המתאימה לג'ימייל:";
    expect(feed(g, pre) + g.endStep()).toBe(pre);
    expect(feed(g, pre) + g.endStep()).toBe("");
    expect(feed(g, pre) + g.endStep()).toBe("");
    expect(g.looping).toBe(false);
    feed(g, pre);
    g.endStep();
    expect(g.looping).toBe(true);
    expect(g.emitted).toBe(pre);
  });

  it("releases a step that starts like an earlier one but goes on differently", () => {
    const g = new LeakGuard();
    feed(g, "Let me check your mail.");
    g.endStep();
    const second = "Let me check your mail. You have 3 new messages.";
    expect(feed(g, second) + g.endStep()).toBe(second);
  });

  it("stops on a line repeated back to back but keeps repeated fields in a list", () => {
    const g = new LeakGuard();
    const out = feed(g, "Searching for the action now\nSearching for the action now\nSearching for the action now\nmore");
    expect(out).toBe("Searching for the action now\n");
    expect(g.looping).toBe(true);

    const list = new LeakGuard();
    const text = "1. Security alert\n   - From: Google <no-reply@google.com>\n2. Setup\n   - From: Google <no-reply@google.com>\n3. Hi\n   - From: Google <no-reply@google.com>";
    expect(feed(list, text) + list.endStep()).toBe(text);
    expect(list.looping).toBe(false);
  });

  it("words the graceful stop in the owner's language", () => {
    expect(gracefulStopText("מה יש לי ביומן")).toMatch(/[\u0590-\u05FF]/);
    expect(gracefulStopText("what's on my calendar")).toMatch(/^I couldn't/);
  });
});

describe("withoutLeakedMarkup", () => {
  it("cuts markup out of assistant text and drops parts left empty", () => {
    const msgs = [
      { role: "assistant", content: [{ type: "text", text: "Checking:<tool_call>x</tool_call>" }] },
      { role: "assistant", content: [{ type: "text", text: "<tool_call>y" }] },
      { role: "tool", content: [] },
    ];
    expect(withoutLeakedMarkup(msgs)).toEqual([{ role: "assistant", content: [{ type: "text", text: "Checking:" }] }, { role: "tool", content: [] }]);
  });
});

// ---- provider integration: a scripted model behind the real CloudflareWorkersAIProvider ----

type Chunk = Record<string, unknown>;
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const textTurn = (...deltas: string[]): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  ...deltas.map((delta) => ({ type: "text-delta", id: "t", delta })),
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
];
const toolTurn = (pre: string, toolName: string, input: unknown): Chunk[] => [
  { type: "stream-start", warnings: [] },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: pre },
  { type: "text-end", id: "t" },
  { type: "tool-call", toolCallId: `c${Math.random()}`, toolName, input: JSON.stringify(input) },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
];

function scripted(turns: Chunk[][]) {
  let i = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: (turns[Math.min(i++, turns.length - 1)] ?? []) as never[] }) }),
  });
  const provider = new CloudflareWorkersAIProvider({} as Ai, "@cf/test/model");
  (provider as unknown as { model: () => unknown }).model = () => model;
  return { provider, model };
}

function fakeTool(name: string, result: unknown) {
  const calls: unknown[] = [];
  const tool: ProviderTool = {
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    execute: async (input) => {
      calls.push(input);
      return result;
    },
  };
  return { tool, calls };
}

async function run(provider: CloudflareWorkersAIProvider, tools: ProviderTool[], message: string, opts: { maxIterations?: number; reserve?: () => boolean } = {}) {
  const events: AgentEvent[] = [];
  for await (const ev of provider.generateWithTools({
    system: "s",
    messages: [{ role: "user", content: message }],
    maxOutputTokens: 100,
    tools,
    maxIterations: opts.maxIterations ?? 8,
    toolBudgetExhausted: () => false,
    reserveNextStep: opts.reserve,
  }))
    events.push(ev);
  const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
  return { events, text };
}

describe("CloudflareWorkersAIProvider leak recovery", () => {
  it("turns a leaked glm tool call into a real call and continues from its result", async () => {
    const search = fakeTool("search_actions", { actions: [{ id: "gmail.search_threads" }] });
    const { provider, model } = scripted([textTurn(YISHAI_LEAK.slice(0, 20), YISHAI_LEAK.slice(20)), textTurn("מצאתי: gmail.search_threads")]);
    const { events, text } = await run(provider, [search.tool], "מה שלושת המיילים האחרונים שלי");
    expect(text).not.toContain("<tool_call>");
    expect(text).not.toContain("arg_key");
    expect(text).toContain("מצאתי: gmail.search_threads");
    expect(search.calls).toEqual([{ query: "gmail get threads", service: "gmail" }]);
    expect(events.find((e) => e.type === "tool-start")).toMatchObject({ name: "search_actions", input: { query: "gmail get threads", service: "gmail" } });
    expect(events.find((e) => e.type === "tool-end")).toMatchObject({ name: "search_actions", output: { actions: [{ id: "gmail.search_threads" }] } });
    expect(model.doStreamCalls).toHaveLength(2);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]!.prompt);
    expect(secondPrompt).toContain("gmail.search_threads");
    expect(secondPrompt).not.toContain("<tool_call>");
    expect(events.at(-1)).toEqual({ type: "usage", usage: { inputTokens: 20, outputTokens: 10 } });
  });

  it("ends gracefully in Hebrew when the leaked call names no real tool", async () => {
    const { provider, model } = scripted([textTurn("רגע:<tool_call>made_up_tool<arg_key>a</arg_key><arg_value>b</arg_value></tool_call>")]);
    const { text } = await run(provider, [fakeTool("search_actions", {}).tool], "מה יש לי ביומן השבוע");
    expect(text).toBe(`רגע:\n\n${gracefulStopText("עברית")}`);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it("does not continue when the daily budget refuses another step", async () => {
    const search = fakeTool("search_actions", {});
    const { provider, model } = scripted([textTurn(YISHAI_LEAK), textTurn("never")]);
    const { text } = await run(provider, [search.tool], "hi", { reserve: () => false });
    expect(search.calls).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(text).toContain(gracefulStopText("hi"));
  });

  it("drops a repeated preamble and stops a stuck tool loop politely", async () => {
    const pre = "אני מנסה לחפש את הפעולה המתאימה לג'ימייל:";
    const search = fakeTool("search_actions", { actions: [] });
    const { provider, model } = scripted([toolTurn(pre, "search_actions", { query: "a" }), toolTurn(pre, "search_actions", { query: "b" }), toolTurn(pre, "search_actions", { query: "c" }), toolTurn(pre, "search_actions", { query: "d" }), textTurn("never")]);
    const { text } = await run(provider, [search.tool], "מה שלושת המיילים האחרונים שלי");
    expect(text.split(pre)).toHaveLength(2);
    expect(text).toContain(gracefulStopText("עברית"));
    expect(text).not.toContain("never");
    expect(model.doStreamCalls.length).toBeLessThanOrEqual(4);
  });

  it("passes a normal answer through untouched", async () => {
    const { provider } = scripted([textTurn("RAM is fast, ", "storage is persistent.")]);
    const { text } = await run(provider, [], "ram vs storage?");
    expect(text).toBe("RAM is fast, storage is persistent.");
  });
});
