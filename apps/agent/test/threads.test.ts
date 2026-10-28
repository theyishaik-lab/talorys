import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { AgentRunner, formatToolResults } from "../src/agent/runner";
import { MAIN_THREAD_ID, ensureFixedThread, projectIdOfThread, projectThreadId, threadContext } from "../src/agent/threads";
import { buildSystemPrompt } from "../src/agent/prompt";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";

/** A provider that only calls tools and never writes text (what talorys-queue-check hit). */
class ToolsOnlyProvider implements AIProvider {
  readonly id = "tools-only";
  generateCalls = 0;
  lastSystem = "";
  constructor(private readonly summary = "Queue is empty.") {}
  async generate(req: GenerateRequest) {
    this.generateCalls++;
    this.lastSystem = JSON.stringify(req.messages);
    return { text: this.summary, usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const tool = req.tools.find((t) => t.name === "list_tasks") ?? req.tools[0]!;
    yield { type: "tool-start", id: "t1", name: tool.name, input: {} };
    const output = await tool.execute({}, "t1").catch((e: unknown) => ({ error: String(e) }));
    yield { type: "tool-end", id: "t1", name: tool.name, output };
  }
}

/** Records the system prompt a chat turn was given. */
class EchoProvider implements AIProvider {
  readonly id = "echo";
  system = "";
  async generate() {
    return { text: "", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    this.system = req.system;
    yield { type: "text", delta: "ok" };
  }
}

describe("fixed threads", () => {
  it("names project threads and recognises them", () => {
    expect(projectThreadId("abc")).toBe("project-abc");
    expect(projectIdOfThread("project-abc")).toBe("abc");
    expect(projectIdOfThread("main")).toBeNull();
    expect(projectIdOfThread("updates-inbox")).toBeNull();
  });

  it("GET /conversations/main creates the main thread on first use", async () => {
    const c = await loggedIn();
    const res = await c.json("/api/conversations/main");
    expect(res.conversation.id).toBe("main");
    expect(Array.isArray(res.messages)).toBe(true);
    // Unknown ids are still 404, and a project thread needs a real project.
    expect((await c.call("/api/conversations/not-a-thread")).status).toBe(404);
    expect((await c.call("/api/conversations/project-nope")).status).toBe(404);
  });

  it("project threads exist only for real projects and go away with the project", async () => {
    const c = await loggedIn();
    const { project } = await c.json("/api/projects", { method: "POST", body: { name: "Kitchen" } });
    const detail = await c.json(`/api/projects/${project.id}`);
    expect(detail.thread_id).toBe(`project-${project.id}`);
    expect(detail.tasks).toEqual([]);
    const thread = await c.json(`/api/conversations/project-${project.id}`);
    expect(thread.conversation.title).toBe("Kitchen");
    await c.json(`/api/projects/${project.id}`, { method: "DELETE" });
    expect((await c.call(`/api/conversations/project-${project.id}`)).status).toBe(404);
  });

  it("the main chat's prompt carries recent notifications, tasks and projects", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      s.notifications.create({ title: "Queue check", body: "3 jobs waiting" });
      s.projects.create({ name: "Garden plan" });
      const ctx = threadContext(s, MAIN_THREAD_ID, "Asia/Jerusalem")!;
      expect(ctx).toContain("Queue check: 3 jobs waiting");
      expect(ctx).toContain("Garden plan");
      expect(buildSystemPrompt({ agentName: "T", timezone: "UTC", now: new Date(), autoMemory: false, memories: [], threadContext: ctx })).toContain("Live context for this chat");
      const echo = new EchoProvider();
      for await (const _ of new AgentRunner(s, echo).chat({ conversationId: MAIN_THREAD_ID, message: "what's new?", signal: new AbortController().signal })) void _;
      expect(echo.system).toContain("Queue check");
      expect(s.conversations.messages(MAIN_THREAD_ID).at(-1)?.content).toBe("ok");
    });
  });

  it("a project thread's prompt carries that project's tasks and notes", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const p = s.projects.create({ name: "Thesis" });
      s.tasks.create({ title: "Write chapter 2", project_id: p.id } as never);
      s.notes.create({ title: "Advisor", content: "Meet on Sunday", project_id: p.id });
      expect(ensureFixedThread(s, projectThreadId(p.id))).toBe(true);
      const ctx = threadContext(s, projectThreadId(p.id), "UTC")!;
      expect(ctx).toContain("Thesis");
      expect(ctx).toContain("Write chapter 2");
      expect(ctx).toContain("Meet on Sunday");
      expect(threadContext(s, "some-other-chat", "UTC")).toBeNull();
    });
  });
});

describe("scheduled runs that only call tools", () => {
  it("write the reply from the tool results instead of '(No output)'", async () => {
    await inAgent(async (a) => {
      const provider = new ToolsOnlyProvider();
      const text = await new AgentRunner(a.services, provider).runScheduledPrompt("check the queue");
      expect(text).toBe("Queue is empty.");
      expect(provider.generateCalls).toBe(1);
      expect(provider.lastSystem).toContain("Tool results");
    });
  });

  it("fall back to a summary of the tool results when the follow-up is empty too", async () => {
    await inAgent(async (a) => {
      const text = await new AgentRunner(a.services, new ToolsOnlyProvider("")).runScheduledPrompt("check the queue");
      expect(text).not.toBe("(No output)");
      expect(text).toContain("here is what the tools returned");
    });
  });

  it("formats tool results compactly and within bounds", () => {
    const out = formatToolResults([{ name: "a", output: { x: "y".repeat(500) } }, { name: "b", output: null, error: "boom" }], 300);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out).toContain("- b: error: boom");
  });
});

describe("app-native connections", () => {
  it("the catalog carries Hebrew names and logos", async () => {
    const c = await loggedIn();
    const { services } = await c.json("/api/connections/catalog");
    const gmail = services.find((s: { id: string }) => s.id === "gmail");
    expect(gmail.he).toBeTruthy();
    expect(gmail.logo).toMatch(/^https:\/\//);
  });

  it("plan and connect refuse without the connector admin, and reject odd ids", async () => {
    const c = await loggedIn();
    expect((await c.call("/api/connections/gmail/plan")).status).not.toBe(200);
    expect((await c.call("/api/connections/gmail/connect", { method: "POST", body: {} })).status).not.toBe(200);
    expect((await c.call("/api/connections/bad!id/plan")).status).toBe(404);
  });
});

describe("empty automation output is never delivered", () => {
  it("recognises empty and '(No output)' results", async () => {
    const { isEmptyAutomationOutput } = await import("../src/agent/talorys-agent");
    for (const t of ["", "  ", "(No output)", "no output", "(no output)."]) expect(isEmptyAutomationOutput(t)).toBe(true);
    expect(isEmptyAutomationOutput("Queue is empty.")).toBe(false);
  });

  it("a silent run with no tool calls returns an empty result", async () => {
    class Silent extends ToolsOnlyProvider {
      override async *generateWithTools(): AsyncIterable<AgentEvent> {}
    }
    await inAgent(async (a) => {
      expect(await new AgentRunner(a.services, new Silent()).runScheduledPrompt("check")).toBe("");
    });
  });

  it("a '(No output)' notification is stored but not pushed or threaded", async () => {
    await inAgent(async (a) => {
      const s = a.services;
      const before = s.conversations.get("updates-inbox")?.id ? s.conversations.messages("updates-inbox").length : 0;
      s.notifications.create({ title: "talorys-queue-check", body: "(No output)" });
      const after = s.conversations.get("updates-inbox") ? s.conversations.messages("updates-inbox").length : 0;
      expect(after).toBe(before);
    });
  });
});
