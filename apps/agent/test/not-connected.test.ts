import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { buildSystemPrompt } from "../src/agent/prompt";
import { OpenConnectorClient, notConnectedService } from "../src/openconnector/client";
import { connectTools, OpenConnectorAdmin } from "../src/openconnector/connect";
import { assertServiceConnected, openConnectorTools } from "../src/openconnector/tools";
import { serviceDisplayName } from "../src/openconnector/services";
import { ALL_TOOLS, runApprovedAction, ToolExecutor, type ToolContext } from "../src/tools";
import { NotConnectedError, type DestructiveTool } from "../src/tools/registry";

/**
 * What happened live on Oct 13, 2026: Google Tasks had no connection, the model proposed
 * `googletasks.insert_task`, the owner approved, the connector refused ("Connect googletasks with
 * OAuth first.") and the model said the task was created. These tests pin the fix: a not-connected
 * app never reaches the Approve card as a run, the model is told plainly, and a connect card for
 * that app rides the same step.
 */

interface Call {
  name: string;
  arguments: Record<string, unknown>;
}

const PROVIDERS: Record<string, unknown> = {
  googletasks: { service: "googletasks", displayName: "Google Tasks", authTypes: ["oauth2"], auth: [{ type: "oauth2", scopes: ["tasks"] }] },
  notion: { service: "notion", displayName: "Notion", authTypes: ["api_key"], auth: [{ type: "api_key", label: "Internal Integration Secret" }] },
  slack: { service: "slack", displayName: "Slack", authTypes: ["oauth2"], auth: [{ type: "oauth2", scopes: ["chat:write"] }] },
};

const CONNECTIONS = [
  { id: "arxiv:default", service: "arxiv", connectionName: "default", authType: "no_auth", profile: { displayName: "arXiv Public" } },
  { id: "gmail:default", service: "gmail", connectionName: "default", authType: "oauth2", profile: { displayName: "yishai@example.com" } },
];

/** A fake OpenConnector: the runtime MCP endpoint (connections, actions) plus the admin API the connect tools use. */
function fake(opts: { configured?: string[]; admin?: boolean } = {}) {
  const calls: Call[] = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const mcp = (payload: unknown) => json(200, { jsonrpc: "2.0", id: 1, result: { structuredContent: payload } });
  const fetcher = {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.json();
      if (url.pathname === "/mcp") {
        const params = (body as { params: { name: string; arguments: Record<string, unknown> } }).params;
        calls.push({ name: params.name, arguments: params.arguments });
        if (params.name === "list_connections") {
          const service = params.arguments.service as string | undefined;
          if (service === "nosuchapp") return mcp({ ok: false, error: { code: "unknown_service", message: "Unknown service: nosuchapp." } });
          return mcp({ ok: true, data: CONNECTIONS.filter((c) => !service || c.service === service) });
        }
        if (params.name === "execute_action") {
          const action = params.arguments.actionId as string;
          const service = action.slice(0, action.indexOf("."));
          if (service === "googletasks") return mcp({ ok: false, error: { code: "authorization_failed", message: "Connect googletasks with OAuth first.", details: { status: 401 } } });
          if (service === "notion") return mcp({ ok: false, error: { code: "authorization_failed", message: "Configure notion credentials first.", details: { status: 401 } } });
          if (service === "slack") return mcp({ ok: false, error: { code: "authorization_failed", message: "Connect slack with OAuth first.", details: { status: 401 } } });
          return mcp({ ok: true, data: { items: [{ title: "Paper" }] } });
        }
        return mcp({ ok: false, error: "unsupported in this fake" });
      }
      const provider = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
      if (provider) return PROVIDERS[provider[1]!] ? json(200, PROVIDERS[provider[1]!]) : json(404, { error: { code: "not_found", message: "Unknown provider" } });
      if (url.pathname === "/api/oauth/configs") return json(200, [...(opts.configured ?? []).map((s) => ({ service: s, configured: true })), { service: "slack", configured: false }]);
      if (url.pathname === "/api/connections" && req.method === "GET") return json(200, CONNECTIONS);
      if (url.pathname === "/api/oauth/authorizations") return json(200, { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?service=${(body as { service: string }).service}` });
      return json(404, { error: { code: "not_found", message: `no route ${url.pathname}` } });
    },
  };
  const runtime = new OpenConnectorClient({ url: "https://connector.example", token: "rt_test", binding: fetcher as unknown as Fetcher });
  const admin = new OpenConnectorAdmin({ url: "https://connector.example", adminToken: "adm_secret", fetcher });
  const tools = opts.admin === false ? openConnectorTools(runtime) : [...openConnectorTools(runtime), ...connectTools(admin, runtime)];
  return { runtime, calls, tools: [...ALL_TOOLS, ...tools] };
}

const ctx = (s: ToolContext["services"], conversationId?: string): ToolContext => ({ services: s, timezone: "UTC", mode: "chat", conversationId });

describe("reading the connector's refusal", () => {
  it("recognises the not-connected answers and names the service", () => {
    expect(notConnectedService({ code: "authorization_failed", message: "Connect googletasks with OAuth first.", details: { status: 401 } })).toBe("googletasks");
    expect(notConnectedService({ code: "authorization_failed", message: "Configure notion credentials first." })).toBe("notion");
    expect(notConnectedService({ code: "connection_not_found", message: "gmail connection not found: work." })).toBe("gmail");
    expect(notConnectedService({ code: "authorization_failed", message: "Configure todoist API key credentials first." })).toBe("todoist");
    expect(notConnectedService({ code: "authorization_failed", message: "Configure trello custom credentials first." })).toBe("trello");
    expect(notConnectedService({ code: "connection_not_found", message: "The requested connection was not found." }, "todoist.get_tasks")).toBe("todoist");
    // A 401 from the provider itself (an expired token, a revoked grant) is not "not connected".
    expect(notConnectedService({ code: "authorization_failed", message: "Google answered 401: invalid_grant" }, "gmail.search_threads")).toBeNull();
    expect(notConnectedService({ code: "invalid_input", message: "Action input does not match the action schema." })).toBeNull();
    expect(notConnectedService("Connect googletasks with OAuth first.")).toBeNull();
    expect(serviceDisplayName("googletasks")).toBe("Google Tasks");
    expect(serviceDisplayName("mystery")).toBe("mystery");
  });

  it("the client throws NotConnectedError for such a refusal, a plain ToolError otherwise", async () => {
    const { runtime } = fake();
    await expect(runtime.data("execute_action", { actionId: "googletasks.list_tasks", input: {} })).rejects.toBeInstanceOf(NotConnectedError);
    await expect(runtime.data("execute_action", { actionId: "notion.search", input: {} })).rejects.toMatchObject({ service: "notion", appName: "Notion", message: "Notion is not connected yet." });
    await expect(runtime.data("list_connections", { service: "nosuchapp" })).rejects.toThrow(/Unknown service/);
  });

  it("assertServiceConnected refuses only a definite empty connection list", async () => {
    const { runtime } = fake();
    await expect(assertServiceConnected(runtime, "googletasks.insert_task")).rejects.toBeInstanceOf(NotConnectedError);
    await expect(assertServiceConnected(runtime, "gmail.send_email")).resolves.toBeUndefined();
    await expect(assertServiceConnected(runtime, "arxiv.get_paper")).resolves.toBeUndefined();
    // An unknown service is the run's problem, not a missing connection.
    await expect(assertServiceConnected(runtime, "nosuchapp.do_thing")).resolves.toBeUndefined();
  });
});

describe("the executor on a not-connected app", () => {
  it("run_action: the model hears it plainly and a connect card rides the same step", async () => {
    const { tools, calls } = fake({ configured: ["googletasks"] });
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const executor = new ToolExecutor(tools, ctx(s, conversation.id), { maxToolCalls: 5 });
      await expect(executor.execute("run_action", { action: "googletasks.list_tasks", input: { tasklistId: "@default" } }, "call-1")).rejects.toThrow(
        /Google Tasks \(googletasks\) is not connected .* nothing was done.* card to connect Google Tasks .* Never say the task was done/s,
      );
      const card = executor.approvalFor("call-1")!;
      expect(card.summary).toBe("Connect Google Tasks");
      expect(card.card).toEqual({ kind: "connect", service: "googletasks", name: "Google Tasks", method: "oauth" });
      expect(s.pendingActions.view(card.id)?.status).toBe("pending");
      // Preparing the card only read the connection list; the consent link comes only after the owner's Approve.
      expect(calls.map((c) => c.name)).toEqual(["execute_action", "list_connections"]);
      // The owner's Approve on that card works like a connect_service proposal.
      const done = await runApprovedAction(tools, ctx(s), card.id);
      expect(done.status).toBe("approved");
      expect(done.card?.authorization_url).toContain("service=googletasks");
    });
  });

  it("propose_action: a not-connected app is refused before any Approve card for the run exists", async () => {
    const { tools, calls } = fake({ configured: ["googletasks"] });
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const executor = new ToolExecutor(tools, ctx(s, conversation.id), { maxToolCalls: 5 });
      await expect(executor.execute("propose_action", { action: "googletasks.insert_task", input: { tasklistId: "@default", title: "לסדר את השולחן" } }, "call-1")).rejects.toThrow(/not connected/);
      expect(calls.map((c) => c.name)).toEqual(["list_connections", "list_connections"]);
      const card = executor.approvalFor("call-1")!;
      expect(card.card?.kind).toBe("connect");
      expect(card.card?.service).toBe("googletasks");
      // No "Run googletasks.insert_task" proposal was created for the owner to approve.
      const summaries = [card.summary];
      expect(summaries).not.toContainEqual(expect.stringMatching(/^Run /));
      // A second attempt on the same app in the turn points at the card instead of adding another.
      await expect(executor.execute("run_action", { action: "googletasks.list_task_lists", input: {} }, "call-2")).rejects.toThrow(/already shown in this reply/);
      expect(executor.approvalFor("call-2")).toBeUndefined();
    });
  });

  it("a connected app proposes as before", async () => {
    const { tools, calls } = fake({ configured: ["googletasks"] });
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const executor = new ToolExecutor(tools, ctx(s, conversation.id), { maxToolCalls: 5 });
      const proposed = (await executor.execute("propose_action", { action: "gmail.send_email", input: { to: "a@b.c" } }, "call-1")) as { status: string };
      expect(proposed.status).toBe("awaiting_owner_approval");
      expect(executor.approvalFor("call-1")?.summary).toMatch(/^Run gmail.send_email/);
      expect(calls.filter((c) => c.name === "execute_action")).toHaveLength(0);
    });
  });

  it("an API-key app gets its secure-field card; an app that needs a one-time setup is said so", async () => {
    const { tools } = fake({ configured: [] });
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const executor = new ToolExecutor(tools, ctx(s, conversation.id), { maxToolCalls: 5 });
      await expect(executor.execute("run_action", { action: "notion.search", input: { query: "x" } }, "call-1")).rejects.toThrow(/Notion \(notion\) is not connected/);
      expect(executor.approvalFor("call-1")?.card).toMatchObject({ kind: "connect", service: "notion", method: "api_key", fields: [expect.objectContaining({ key: "apiKey", secret: true })] });
      await expect(executor.execute("run_action", { action: "slack.list_channels", input: {} }, "call-2")).rejects.toThrow(/Slack \(slack\) is not connected .* one-time setup/s);
      expect(executor.approvalFor("call-2")).toBeUndefined();
    });
  });

  it("without the connect tools or a chat, the model still hears that nothing ran", async () => {
    const { tools } = fake({ admin: false });
    await inAgent(async (a) => {
      const s = a.services;
      const executor = new ToolExecutor(tools, { services: s, timezone: "UTC", mode: "scheduled" }, { maxToolCalls: 5 });
      await expect(executor.execute("run_action", { action: "googletasks.list_tasks", input: {} }, "call-1")).rejects.toThrow(/not connected .* nothing was done.* connector console/s);
      expect(executor.approvalFor("call-1")).toBeUndefined();
    });
  });

  it("an already-approved run on an app that lost its connection fails with a plain reason on the card", async () => {
    const { tools } = fake();
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const propose = tools.find((t) => t.name === "propose_action") as DestructiveTool;
      const target = JSON.stringify({ action: "googletasks.insert_task", input: { title: "x" } });
      const pending = s.pendingActions.create({ conversation_id: conversation.id, tool: propose.name, target_id: target, summary: "Run googletasks.insert_task" });
      const done = await runApprovedAction(tools, ctx(s), pending.id);
      expect(done.status).toBe("failed");
      expect(done.error).toBe("Google Tasks is not connected yet.");
    });
  });

  it("the prompt tells the model what to do with a not-connected answer", () => {
    const prompt = buildSystemPrompt({ agentName: "T", timezone: "UTC", now: new Date(), autoMemory: false, memories: [], connectors: true });
    expect(prompt).toMatch(/not connected, say so plainly .* never say the task was done/);
  });
});
