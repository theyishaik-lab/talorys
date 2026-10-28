import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { AgentRunner } from "../src/agent/runner";
import { MAIN_THREAD_ID, ensureFixedThread, projectIdOfThread, projectThreadId, threadContext } from "../src/agent/threads";
import { buildSystemPrompt } from "../src/agent/prompt";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";

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
