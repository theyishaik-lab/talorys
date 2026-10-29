import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@talorys/shared";
import { inAgent, loggedIn } from "./helpers";
import { AgentRunner } from "../src/agent/runner";
import { buildContextWindow } from "../src/agent/memory";
import {
  CONTEXT_BUDGETS,
  abridgedSection,
  cleanSummary,
  compactionBatch,
  compactionPrompt,
  isContextOverflow,
  looksLikeContextOverflow,
  shouldCompact,
  toolsNote,
} from "../src/agent/context";
import { DIGEST_LIMITS, MAIN_THREAD_ID, projectThreadId, threadContext } from "../src/agent/threads";
import { classifyAiError, type AgentEvent, type AIProvider, type GenerateRequest, type ToolRequest } from "../src/ai/provider";
import { cooldownFor } from "../src/ai/cooldown";
import { chainError } from "../src/ai/attribution";
import { AppError } from "../src/api/errors";
import { ensureMessageSearch, messageMatch, searchMessages, searchTerms, snippet } from "../src/db/message-search";
import { ALL_TOOLS, ToolExecutor } from "../src/tools";
import type { Services } from "../src/services/container";

const T0 = 1_760_000_000_000;
function msg(i: number, content: string, role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant"): ChatMessage {
  return { id: `m${i}`, conversation_id: "c", role, content, tools: [], status: "complete", error: null, created_at: new Date(T0 + i * 1000).toISOString() };
}

/** Summarizes with a fixed text and answers turns; records what each call was given. */
class RecordingProvider implements AIProvider {
  readonly id = "recording";
  generateCalls: GenerateRequest[] = [];
  turns: ToolRequest[] = [];
  /** Throw this (once per entry) from generateWithTools before answering. */
  failures: unknown[] = [];
  constructor(private readonly summary = "**Context**\n- The owner is planning a trip to Haifa and prefers trains.") {}
  async generate(req: GenerateRequest) {
    this.generateCalls.push(req);
    return { text: this.summary, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    this.turns.push(req);
    const failure = this.failures.shift();
    if (failure) throw failure;
    yield { type: "text", delta: "ok" };
  }
}

async function chat(s: Services, provider: AIProvider, conversationId: string | undefined, message: string) {
  const events: any[] = [];
  for await (const e of new AgentRunner(s, provider).chat({ conversationId, message, signal: new AbortController().signal })) events.push(e);
  return events;
}

async function withLimits(limits: Record<string, number>, fn: (s: Services) => Promise<void>) {
  await inAgent(async (a) => {
    const s = a.services;
    const original = s.settings.get().limits;
    s.settings.update({ limits: { maxAiRequestsPerDay: 100_000, ...limits } });
    try {
      await fn(s);
    } finally {
      s.settings.update({ limits: original });
    }
  });
}

function fill(s: Services, id: string, n: number, chars = 1600, word = "filler") {
  for (let i = 0; i < n; i++) s.conversations.addMessage({ conversation_id: id, role: i % 2 ? "assistant" : "user", content: `${word} ${i} ${"x".repeat(chars)}` });
}

describe("token budget", () => {
  it("keeps the newest messages within the budget and reports the rest as overflow", () => {
    const msgs = Array.from({ length: 30 }, (_, i) => msg(i, "y".repeat(800)));
    const w = buildContextWindow(msgs, 2000, null);
    const used = w.messages.reduce((n, m) => n + Math.ceil(m.content.length / 4) + 4, 0);
    expect(used).toBeLessThanOrEqual(2000);
    expect(w.overflow.length + w.messages.length).toBe(30);
    expect(w.overflow.at(-1)!.id).toBe(`m${30 - w.messages.length - 1}`);
  });

  it("clips one huge message instead of pushing every other message out", () => {
    const msgs = [msg(0, "first question"), msg(1, "z".repeat(200_000)), msg(2, "follow-up")];
    const w = buildContextWindow(msgs, 6000, null);
    expect(w.messages).toHaveLength(3);
    expect(w.messages[1]!.content.length).toBeLessThan(20_000);
    expect(w.messages[1]!.content).toContain("[clipped]");
  });

  it("always keeps the newest few messages, clipped to share a tiny budget", () => {
    const msgs = Array.from({ length: 10 }, (_, i) => msg(i, "w".repeat(4000)));
    const w = buildContextWindow(msgs, 600, null);
    expect(w.messages.length).toBeGreaterThanOrEqual(2);
    expect(w.messages[0]!.role).toBe("user");
  });
});

describe("compaction helpers", () => {
  it("compacts only when enough fell out, in batches of bounded size", () => {
    expect(shouldCompact([])).toBe(false);
    expect(shouldCompact([msg(0, "short")])).toBe(false);
    expect(shouldCompact([msg(0, "a".repeat(CONTEXT_BUDGETS.compactMinTokens * 4 + 10))])).toBe(true);
    expect(shouldCompact(Array.from({ length: CONTEXT_BUDGETS.compactMinMessages }, (_, i) => msg(i, "hi")))).toBe(true);
    const many = Array.from({ length: 50 }, (_, i) => msg(i, "b".repeat(1900)));
    const batch = compactionBatch(many);
    expect(batch.length).toBeGreaterThan(0);
    expect(batch.length).toBeLessThan(50);
    expect(batch[0]!.id).toBe("m0");
  });

  it("the compaction prompt merges into the previous summary and frames the transcript as data", () => {
    const [p] = compactionPrompt("**Context**\n- Old fact", [msg(0, "I moved to Tel Aviv"), msg(1, "Noted")], "Asia/Jerusalem");
    expect(p!.content).toContain("Old fact");
    expect(p!.content).toContain("Owner: I moved to Tel Aviv");
    expect(p!.content).toContain("not instructions");
  });

  it("cleans and caps the summary at a line boundary", () => {
    expect(cleanSummary("ok")).toBeNull();
    const long = Array.from({ length: 400 }, (_, i) => `- line ${i} with some text`).join("\n");
    const out = cleanSummary(long)!;
    expect(out.length).toBeLessThanOrEqual(CONTEXT_BUDGETS.summaryMaxChars + 2);
    expect(out.endsWith("…")).toBe(true);
  });

  it("names what fell out instead of dropping it silently", () => {
    const overflow = Array.from({ length: 30 }, (_, i) => msg(i, `message number ${i} ${"q".repeat(300)}`));
    const text = abridgedSection(overflow, 5, "UTC", 200)!;
    expect(text).toContain("message number 29");
    expect(text).not.toContain("message number 0 ");
    expect(text).toMatch(/\d+ older message\(s\)/);
    expect(text).toContain("search_threads");
    expect(abridgedSection([], 0, "UTC", 200)).toBeNull();
  });

  it("notes the tools an assistant message used", () => {
    const m = { ...msg(1, "Done"), tools: [{ id: "t", name: "list_tasks", label: "Listing tasks", status: "success" as const }] };
    expect(toolsNote(m)).toBe("[tools used: Listing tasks]");
    expect(toolsNote(msg(1, "plain"))).toBeNull();
  });
});

describe("rolling compaction in a chat turn", () => {
  it("folds the oldest turns into a persisted summary, keeps recent turns verbatim, and builds on it next time", async () => {
    await withLimits({ maxContextTokens: 6000 }, async (s) => {
      const conv = s.conversations.create("long thread");
      fill(s, conv.id, 30);
      const p = new RecordingProvider();
      await chat(s, p, conv.id, "where were we?");
      expect(p.generateCalls).toHaveLength(1);
      const stored = s.conversations.get(conv.id)!;
      expect(stored.summary).toContain("Haifa");
      expect(stored.summary_upto).toBeTruthy();
      expect(stored.summary_messages).toBeGreaterThan(0);
      // The turn's prompt carries the summary; the newest message is verbatim, the summarized ones are not resent.
      const turn = p.turns[0]!;
      expect(turn.system).toContain("Summary of earlier parts of this conversation");
      expect(turn.messages.at(-1)!.content).toBe("where were we?");
      expect(turn.messages.some((m) => m.content.startsWith("filler 0 "))).toBe(false);

      // Next compaction is incremental: the previous summary goes into the prompt.
      fill(s, conv.id, 20, 1600, "later");
      const p2 = new RecordingProvider("**Context**\n- Haifa trip, trains; later the owner booked a hotel.");
      await chat(s, p2, conv.id, "and now?");
      expect(p2.generateCalls).toHaveLength(1);
      expect(p2.generateCalls[0]!.messages[0]!.content).toContain("prefers trains");
      const after = s.conversations.get(conv.id)!;
      expect(after.summary_messages).toBeGreaterThan(stored.summary_messages!);
      expect(after.summary_upto! > stored.summary_upto!).toBe(true);
    });
  });

  it("shows unsummarized overflow abridged when compaction cannot run", async () => {
    await withLimits({ maxContextTokens: 3000 }, async (s) => {
      const conv = s.conversations.create("no budget for summaries");
      fill(s, conv.id, 20, 1200, "older");
      s.settings.update({ limits: { maxAiRequestsPerDay: s.usage.today().ai_requests + 1 } });
      const p = new RecordingProvider();
      await chat(s, p, conv.id, "hello");
      expect(p.generateCalls).toHaveLength(0);
      expect(p.turns[0]!.system).toContain("Earlier messages in this chat, abridged");
      expect(s.conversations.get(conv.id)!.summary).toBeNull();
    });
  });

  it("does not compact a short thread", async () => {
    await withLimits({ maxContextTokens: 32_000 }, async (s) => {
      const conv = s.conversations.create("short");
      fill(s, conv.id, 4, 200);
      const p = new RecordingProvider();
      await chat(s, p, conv.id, "hi");
      expect(p.generateCalls).toHaveLength(0);
      expect(p.turns[0]!.messages).toHaveLength(5);
    });
  });

  it("the API reports how many messages were summarized, never the summary itself", async () => {
    const c = await loggedIn();
    const id = await inAgent((a) => {
      const conv = a.services.conversations.create("api");
      a.services.conversations.setSummary(conv.id, "secret summary", new Date().toISOString(), 7);
      return conv.id;
    });
    const res = await c.json(`/api/conversations/${id}`);
    expect(res.conversation.summarized_messages).toBe(7);
    expect(res.conversation.summary).toBeUndefined();
    expect(res.conversation.digest_at).toBeUndefined();
  });
});

describe("context overflow", () => {
  it("recognises provider overflow wording but not rate limits", () => {
    expect(looksLikeContextOverflow("This model's maximum context length is 131072 tokens. However, you requested 150000 tokens")).toBe(true);
    expect(looksLikeContextOverflow("The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)")).toBe(true);
    expect(looksLikeContextOverflow("prompt is too long: 210000 tokens > 200000 maximum")).toBe(true);
    expect(looksLikeContextOverflow("Rate limit reached for tokens per minute", 429)).toBe(false);
    expect(looksLikeContextOverflow("Service unavailable")).toBe(false);
  });

  it("classifies overflow without pausing the model, and finds it inside a fallback-chain error", () => {
    const raw = Object.assign(new Error("Bad Request: context_length_exceeded"), { statusCode: 400 });
    const err = classifyAiError(raw, "openrouter", "x/model");
    expect(err.code).toBe("AI_UNAVAILABLE");
    expect(isContextOverflow(err)).toBe(true);
    expect(cooldownFor(err, Date.now())).toBeNull();
    const chained = chainError(err, [
      { provider: "openrouter", model: "x/model", code: "AI_UNAVAILABLE", reason: "error", status: 400, error: err.message },
      { provider: "gemini", model: "g", code: "AI_UNAVAILABLE", reason: "error", status: 400, error: "The input token count exceeds the maximum" },
    ]);
    expect(isContextOverflow(chained)).toBe(true);
    expect(isContextOverflow(new AppError("AI_UNAVAILABLE", "busy"))).toBe(false);
  });

  it("compacts and retries once instead of failing the turn", async () => {
    await withLimits({ maxContextTokens: 20_000 }, async (s) => {
      const conv = s.conversations.create("overflow");
      fill(s, conv.id, 10, 6000);
      const p = new RecordingProvider();
      p.failures.push(new Error("This model's maximum context length is 8192 tokens"));
      const events = await chat(s, p, conv.id, "go on");
      expect(events.find((e) => e.type === "error")).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "complete", content: "ok" } });
      expect(p.turns).toHaveLength(2);
      expect(p.generateCalls.length).toBeGreaterThanOrEqual(1);
      const size = (r: ToolRequest) => r.messages.reduce((n, m) => n + m.content.length, 0);
      expect(size(p.turns[1]!)).toBeLessThan(size(p.turns[0]!));
    });
  });

  it("fails normally when the retry overflows too", async () => {
    await withLimits({ maxContextTokens: 20_000 }, async (s) => {
      const conv = s.conversations.create("overflow twice");
      fill(s, conv.id, 6, 400);
      const p = new RecordingProvider();
      p.failures.push(new Error("maximum context length exceeded"), new Error("maximum context length exceeded"));
      const events = await chat(s, p, conv.id, "go on");
      expect(events.find((e) => e.type === "error")).toBeTruthy();
      expect(p.turns).toHaveLength(2);
    });
  });
});

describe("compact digest", () => {
  it("stays small, marks what is new since the last turn and points at tools", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      for (let i = 0; i < 12; i++) s.notifications.create({ title: `Digest item ${i}`, body: "b".repeat(2000) });
      for (let i = 0; i < 12; i++) s.projects.create({ name: `Digest project ${i}` });
      const ctx = threadContext(s, MAIN_THREAD_ID, "UTC")!;
      expect(ctx.length).toBeLessThanOrEqual(DIGEST_LIMITS.mainMaxChars + 2);
      expect(ctx).toMatch(/Digest item \d+/);
      expect(ctx).toMatch(/and \d+ more \(list_notifications\)/);
      expect(ctx).not.toContain("b".repeat(200));
      expect(ctx).toContain("list_notifications");
      expect(ctx).toContain("search_threads");

      const since = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 5));
      s.notifications.create({ title: "Fresh one", body: "after the cursor" });
      const next = threadContext(s, MAIN_THREAD_ID, "UTC", new Date(), since)!;
      expect(next).toContain("Fresh one: after the cursor (new)");
      expect(next).toMatch(/1 new/);
    });
  });

  it("a main-chat turn advances the digest cursor", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const p = new RecordingProvider();
      for await (const _ of new AgentRunner(s, p).chat({ conversationId: MAIN_THREAD_ID, message: "status?", signal: new AbortController().signal })) void _;
      const first = s.conversations.get(MAIN_THREAD_ID)!.digest_at;
      expect(first).toBeTruthy();
      for await (const _ of new AgentRunner(s, p).chat({ conversationId: MAIN_THREAD_ID, message: "again", signal: new AbortController().signal })) void _;
      expect(p.turns.at(-1)!.system).toContain("You last saw this digest at");
    });
  });

  it("project digests are capped too", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const p = s.projects.create({ name: "Big project" });
      for (let i = 0; i < 40; i++) s.tasks.create({ title: `Task ${i} ${"t".repeat(80)}`, project_id: p.id } as never);
      const ctx = threadContext(s, projectThreadId(p.id), "UTC")!;
      expect(ctx.length).toBeLessThanOrEqual(DIGEST_LIMITS.projectMaxChars + 2);
      expect(ctx).toContain("Open tasks (40)");
      expect(ctx).toContain("project_overview");
    });
  });
});

describe("cross-thread search", () => {
  it("builds safe match expressions and snippets", () => {
    expect(searchTerms("What did we decide about the Haifa trip?")).toEqual(["we", "decide", "haifa", "trip"]);
    expect(messageMatch(["haifa", "we"], "trigram")).toBe('"haifa"');
    expect(messageMatch(["haifa"], "words")).toBe('"haifa"*');
    expect(messageMatch(["haifa"], "like")).toBeNull();
    expect(snippet(`${"a ".repeat(300)}needle ${"b ".repeat(300)}`, ["needle"], 100)).toContain("needle");
  });

  it("finds messages in project and notification threads, including Hebrew with prefixes", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      expect(["trigram", "words", "like"]).toContain(ensureMessageSearch(s.db));
      const p = s.projects.create({ name: "Search test project" });
      const pid = projectThreadId(p.id);
      s.conversations.ensure(pid, p.name);
      s.conversations.addMessage({ conversation_id: pid, role: "user", content: "We chose the zanzibarian supplier for the tiles" });
      s.conversations.addMessage({ conversation_id: pid, role: "assistant", content: "קבענו פגישה עם הקבלן ביום ראשון" });
      s.notifications.create({ title: "Quokka report", body: "The quokkafeed automation found 3 items" });

      const hits = searchMessages(s.db, "zanzibarian supplier");
      expect(hits[0]).toMatchObject({ conversation_id: pid, role: "user" });
      expect(searchMessages(s.db, "quokkafeed")[0]!.conversation_id).toMatch(/^updates-/);
      // "קבלן" appears only as "הקבלן" (with the definite-article prefix).
      expect(searchMessages(s.db, "קבלן").some((h) => h.conversation_id === pid)).toBe(true);
      expect(searchMessages(s.db, "zanzibarian", { excludeConversationId: pid })).toHaveLength(0);
      // Deleted messages leave the index.
      s.conversations.delete(pid);
      expect(searchMessages(s.db, "zanzibarian")).toHaveLength(0);
    });
  });
});

describe("context tools", () => {
  function exec(s: Services, conversationId = MAIN_THREAD_ID) {
    return new ToolExecutor(ALL_TOOLS, { services: s, timezone: "UTC", mode: "chat", conversationId }, { maxToolCalls: 20 });
  }

  it("search_threads and read_thread reach other threads from main", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const p = s.projects.create({ name: "Recall project" });
      const pid = projectThreadId(p.id);
      s.conversations.ensure(pid, p.name);
      const m = s.conversations.addMessage({ conversation_id: pid, role: "user", content: "The flibbertigibbet budget is 4,000 shekels" });
      s.conversations.addMessage({ conversation_id: pid, role: "assistant", content: "Noted the budget." });
      const x = exec(s);
      const found = (await x.execute("search_threads", { query: "flibbertigibbet budget" })) as any;
      expect(found.results[0]).toMatchObject({ thread: pid, kind: "project", thread_title: "Recall project" });
      expect(found.results[0].excerpt).toContain("4,000");
      const thread = (await x.execute("read_thread", { thread: pid, before_message_id: m.id })) as any;
      expect(thread.messages.map((y: any) => y.text)).toContain("The flibbertigibbet budget is 4,000 shekels");
      const list = (await x.execute("read_thread", {})) as any;
      expect(list.threads.some((t: any) => t.thread === pid)).toBe(true);
    });
  });

  it("list_notifications, automation_runs and project_overview fetch details on demand", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      s.notifications.create({ title: "Wombat check", body: "W".repeat(900) });
      const p = s.projects.create({ name: "Overview project" });
      s.tasks.create({ title: "Overview task", project_id: p.id } as never);
      s.notes.create({ title: "Overview note", content: "details", project_id: p.id });
      const x = exec(s);
      const notes = (await x.execute("list_notifications", { query: "wombat" })) as any;
      expect(notes.notifications[0].body.length).toBeGreaterThan(800);
      expect(notes.notifications[0].thread).toBe("updates-inbox");
      expect(((await x.execute("automation_runs", {})) as any).runs).toBeInstanceOf(Array);
      const ov = (await x.execute("project_overview", { project: "Overview project" })) as any;
      expect(ov.open_tasks[0].title).toBe("Overview task");
      expect(ov.notes[0].title).toBe("Overview note");
      await expect(x.execute("project_overview", { project: "nope-nope" })).rejects.toThrow(/does not exist/);
    });
  });

  it("memory tools remember, search and update durable facts, and forgetting needs approval", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const x = exec(s);
      const r = (await x.execute("remember", { content: "The owner prefers aisle seats on flights", category: "preference" })) as any;
      const id = r.remembered.id;
      const found = (await x.execute("search_memories", { query: "aisle seats" })) as any;
      expect(found.memories.some((m: any) => m.id === id)).toBe(true);
      await x.execute("update_memory", { id, content: "The owner prefers window seats on flights" });
      expect(s.memories.get(id)?.content ?? "").toMatch(/window|aisle/);
      const f = (await x.execute("forget_memory", { id })) as any;
      expect(f.status).toBe("awaiting_owner_approval");
    });
  });

  it("scheduled runs get the read-only context tools", async () => {
    await inAgent(async (a) => {
      const x = new ToolExecutor(ALL_TOOLS, { services: a.services, timezone: "UTC", mode: "scheduled" }, { maxToolCalls: 4 });
      const names = x.available().map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["search_threads", "read_thread", "list_notifications", "project_overview", "automation_runs"]));
    });
  });
});
