import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { buildSystemPrompt, CONNECTOR_RULE, NO_ACCESS_RULE } from "../src/agent/prompt";
import type { Env } from "../src/env";
import { compactResult, isPlatformLimitError, servicesHintedBy, truncateResult } from "../src/openconnector/client";
import { rankCatalogRows, schemaInputLines } from "../src/openconnector/tools";
import { OpenConnectorClient, isReadOnlyAction, openConnectorTools, toolsWithOpenConnector, withOpenConnector } from "../src/openconnector";
import { guideInputs, proposalSummary, withActionDefaults } from "../src/openconnector/tools";
import { ALL_TOOLS, runApprovedAction, ToolExecutor, type ToolContext } from "../src/tools";
import type { DestructiveTool, ImmediateTool } from "../src/tools/registry";

interface Call {
  name: string;
  arguments: Record<string, unknown>;
  authorization: string | null;
  url: string;
}

/** A fake OpenConnector Worker: records every MCP call and answers from `reply`. */
function fakeConnector(reply: (call: Call) => unknown, opts: { sse?: boolean; status?: number } = {}) {
  const calls: Call[] = [];
  const binding = {
    fetch: async (req: Request) => {
      const body = (await req.json()) as { params: { name: string; arguments: Record<string, unknown> } };
      const call: Call = { name: body.params.name, arguments: body.params.arguments, authorization: req.headers.get("authorization"), url: req.url };
      calls.push(call);
      if (opts.status) return new Response("nope", { status: opts.status });
      const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: reply(call) } });
      return opts.sse
        ? new Response(`event: message\ndata: ${rpc}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : new Response(rpc, { headers: { "content-type": "application/json" } });
    },
  } as unknown as Fetcher;
  const client = new OpenConnectorClient({ binding, token: "rt_test" });
  return { client, calls, tools: openConnectorTools(client) };
}

const immediate = (tools: ReturnType<typeof openConnectorTools>, name: string) => tools.find((t) => t.name === name)! as ImmediateTool;
const destructive = (tools: ReturnType<typeof openConnectorTools>, name: string) => tools.find((t) => t.name === name)! as DestructiveTool;

const CONNECTIONS = [
  { id: "arxiv:default", service: "arxiv", connectionName: "default", authType: "no_auth", profile: { displayName: "arXiv Public" } },
  { id: "gmail:default", service: "gmail", connectionName: "default", authType: "oauth2", profile: { displayName: "yishai@example.com" } },
];

describe("read/write classification", () => {
  it("treats get/list/search/fetch as reads and everything else as changes", () => {
    for (const id of ["arxiv.get_paper", "gmail.search_threads", "github.list_issues", "notion.fetch_page", "crossref.lookup_doi"]) expect(isReadOnlyAction(id)).toBe(true);
    for (const id of ["gmail.send_email", "notion.create_page", "github.update_issue", "todoist.delete_task", "slack.post_message", "x.unknown"]) expect(isReadOnlyAction(id)).toBe(false);
  });
});

describe("openconnector tools", () => {
  const ctx = (s: ToolContext["services"], conversationId?: string): ToolContext => ({ services: s, timezone: "UTC", mode: "chat", conversationId });

  it("are only added when the token and a binding or URL are configured", () => {
    const base = ALL_TOOLS.length;
    expect(toolsWithOpenConnector({} as Env)).toHaveLength(base);
    expect(toolsWithOpenConnector({ OPEN_CONNECTOR_TOKEN: "x" } as Env)).toHaveLength(base);
    expect(toolsWithOpenConnector({ OPEN_CONNECTOR_URL: "https://c.example" } as Env)).toHaveLength(base);
    expect(toolsWithOpenConnector({ OPEN_CONNECTOR_TOKEN: "x", OPEN_CONNECTOR_URL: "https://c.example" } as Env)).toHaveLength(base + 5);
    expect(toolsWithOpenConnector({ OPEN_CONNECTOR_TOKEN: "x", OPEN_CONNECTOR: {} as Fetcher } as Env)).toHaveLength(base + 5);
  });

  it("sends the runtime token to /mcp and understands SSE answers", async () => {
    const { client, calls } = fakeConnector(() => ({ ok: true, data: [{ service: "notion" }] }), { sse: true });
    expect(await client.data("list_apps", { query: "notion" })).toEqual([{ service: "notion" }]);
    expect(calls[0]).toMatchObject({ name: "list_apps", arguments: { query: "notion" }, authorization: "Bearer rt_test", url: "https://open-connector/mcp" });
  });

  it("turns a rejected token into a readable tool error", async () => {
    const { tools } = fakeConnector(() => ({}), { status: 401 });
    await inAgent(async (a) => {
      await expect(immediate(tools, "connected_apps").execute({}, ctx(a.services))).rejects.toThrow(/runtime token/);
    });
  });

  it("connected_apps separates accounts from public services", async () => {
    const { tools } = fakeConnector(() => ({ ok: true, data: CONNECTIONS }));
    await inAgent(async (a) => {
      const result = await immediate(tools, "connected_apps").execute({}, ctx(a.services));
      expect(result).toMatchObject({
        connected: [{ service: "gmail", connection: "default", account: "yishai@example.com" }],
        public_services_without_login: ["arxiv"],
      });
    });
  });

  it("search_actions compacts the catalog rows", async () => {
    const { tools, calls } = fakeConnector(() => ({
      ok: true,
      data: [
        {
          id: "gmail.send_email",
          description: "Send an email from the connected Gmail account.",
          capability: { execution: { noAuthRunnable: false }, connection: { configured: false } },
          inputSummary: [{ name: "to", required: true, type: "string", description: "Recipient" }],
        },
      ],
    }));
    await inAgent(async (a) => {
      const result = (await immediate(tools, "search_actions").execute({ query: "send email", service: "gmail" }, ctx(a.services))) as { actions: unknown[] };
      expect(calls[0]!.arguments).toEqual({ query: "send email", service: "gmail", limit: 8 });
      expect(result.actions).toEqual([
        { id: "gmail.send_email", description: "Send an email from the connected Gmail account.", read_only: false, ready: false, inputs: ["to (string, required): Recipient"] },
      ]);
    });
  });

  it("run_action executes reads and truncates big results", async () => {
    const { tools, calls } = fakeConnector(() => ({ ok: true, data: { title: "Attention Is All You Need", abstract: "x".repeat(5000) } }));
    await inAgent(async (a) => {
      const result = (await immediate(tools, "run_action").execute({ action: "arxiv.get_paper", input: { id: "1706.03762" } }, ctx(a.services))) as { truncated?: boolean; text?: string };
      expect(calls[0]).toMatchObject({ name: "execute_action", arguments: { actionId: "arxiv.get_paper", input: { id: "1706.03762" } } });
      expect(result.truncated).toBe(true);
      expect(result.text).toContain("Attention Is All You Need");
    });
  });

  it("run_action defaults a Google Calendar event read to the primary calendar", async () => {
    const { tools, calls } = fakeConnector(() => ({ ok: true, data: { items: [] } }));
    await inAgent(async (a) => {
      await immediate(tools, "run_action").execute({ action: "googlecalendar.list_events", input: { timeMin: "2026-10-13T00:00:00Z" } }, ctx(a.services));
      expect(calls[0]).toMatchObject({ arguments: { actionId: "googlecalendar.list_events", input: { timeMin: "2026-10-13T00:00:00Z", calendarId: "primary" } } });
    });
  });

  it("calendar defaults never override a named calendar or touch other actions", () => {
    expect(withActionDefaults("googlecalendar.list_events", { calendarId: "work@x" })).toEqual({ calendarId: "work@x" });
    expect(withActionDefaults("googlecalendar.find_event", { calendarId: " " })).toEqual({ calendarId: "primary" });
    expect(withActionDefaults("googlecalendar.list_calendars", {})).toEqual({});
    expect(withActionDefaults("googlecalendar.clear_calendar", {})).toEqual({});
    expect(withActionDefaults("googlecalendar.delete_calendar", {})).toEqual({});
    expect(withActionDefaults("gmail.search_threads", {})).toEqual({});
  });

  it("propose_action shows the defaulted calendar in what the owner approves", async () => {
    const { tools } = fakeConnector(() => ({ ok: true, data: {} }));
    await inAgent(async (a) => {
      const conversation = a.services.conversations.create("test");
      const prepared = await destructive(tools, "propose_action").prepare({ action: "googlecalendar.create_event", input: { summary: "Gym" } }, ctx(a.services, conversation.id));
      expect(JSON.parse(prepared.targetId).input).toEqual({ summary: "Gym", calendarId: "primary" });
      expect(prepared.summary).toContain("primary");
    });
  });

  it("a schema failure tells the model which input is missing", async () => {
    const { tools } = fakeConnector(() => ({
      ok: false,
      error: {
        code: "invalid_input",
        message: "Action input does not match the action schema.",
        details: [{ keyword: "required", error: 'Instance does not have required property "issueNumber".' }],
      },
    }));
    await inAgent(async (a) => {
      await expect(immediate(tools, "run_action").execute({ action: "github.get_issue", input: {} }, ctx(a.services))).rejects.toThrow(/required property "issueNumber"/);
    });
  });

  it("run_action refuses a change and points at propose_action without calling the connector", async () => {
    const { tools, calls } = fakeConnector(() => ({ ok: true, data: {} }));
    await inAgent(async (a) => {
      const result = await immediate(tools, "run_action").execute({ action: "gmail.send_email", input: { to: "a@b.c" } }, ctx(a.services));
      expect(result).toMatchObject({ status: "needs_approval" });
      expect(calls).toHaveLength(0);
    });
  });

  it("propose_action only proposes; the approved action runs once and leaves a notification", async () => {
    const { tools, calls } = fakeConnector(() => ({ ok: true, data: { id: "msg_1", status: "sent" } }));
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const executor = new ToolExecutor([...ALL_TOOLS, ...tools], ctx(s, conversation.id), { maxToolCalls: 5 });
      const proposed = (await executor.execute("propose_action", { action: "gmail.send_email", input: { to: "a@b.c", subject: "Hi" } }, "call-1")) as { status: string };
      expect(proposed.status).toBe("awaiting_owner_approval");
      // Proposing only checks that the app is connected; it runs nothing.
      expect(calls.map((c) => c.name)).toEqual(["list_connections"]);
      const pending = executor.approvalFor("call-1")!;
      expect(pending.summary).toBe("Run gmail.send_email — to: “a@b.c”, subject: “Hi”");

      const done = await runApprovedAction([...ALL_TOOLS, ...tools], ctx(s), pending.id);
      expect(done.status).toBe("approved");
      expect(calls.filter((c) => c.name === "execute_action")).toEqual([expect.objectContaining({ name: "execute_action", arguments: { actionId: "gmail.send_email", input: { to: "a@b.c", subject: "Hi" } } })]);
      const note = s.notifications.list({ limit: 1 })[0]!;
      expect(note.title).toBe("Done");
      expect(note.body).toContain("gmail.send_email");
      expect(note.body).toContain("msg_1");
      // A second approval of the same action never runs it again.
      await expect(runApprovedAction([...ALL_TOOLS, ...tools], ctx(s), pending.id)).rejects.toThrow(/already handled/);
      expect(calls.filter((c) => c.name === "execute_action")).toHaveLength(1);
    });
  });

  it("an approved action that fails is marked failed with the connector's words", async () => {
    const { tools } = fakeConnector(() => ({ ok: false, error: { code: "rate_limited", message: "Gmail answered 429: quota exceeded" } }));
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const prepared = await destructive(tools, "propose_action").prepare({ action: "gmail.send_email", input: {} }, ctx(s, conversation.id));
      const pending = s.pendingActions.create({ conversation_id: conversation.id, tool: "propose_action", target_id: prepared.targetId, summary: prepared.summary });
      const done = await runApprovedAction([...ALL_TOOLS, ...tools], ctx(s), pending.id);
      expect(done.status).toBe("failed");
      expect(done.error).toContain("quota exceeded");
    });
  });

  it("scheduled runs only see the read tools", async () => {
    const { tools } = fakeConnector(() => ({ ok: true, data: [] }));
    await inAgent((a) => {
      const executor = new ToolExecutor(tools, { services: a.services, timezone: "UTC", mode: "scheduled" }, { maxToolCalls: 4 });
      expect(executor.available().map((t) => t.name)).toEqual(["connected_apps", "search_actions", "action_guide", "run_action"]);
    });
  });
});

describe("prompt and extensions", () => {
  const base = { agentName: "T", timezone: "UTC", now: new Date("2026-10-13T00:00:00Z"), autoMemory: true, memories: [] };

  it("swaps the no-access rule for the connector rule when connectors are on", () => {
    expect(buildSystemPrompt(base)).toContain(NO_ACCESS_RULE);
    expect(buildSystemPrompt(base)).not.toContain(CONNECTOR_RULE);
    expect(buildSystemPrompt({ ...base, connectors: true })).toContain(CONNECTOR_RULE);
    expect(buildSystemPrompt({ ...base, connectors: true })).not.toContain(NO_ACCESS_RULE);
  });

  it("withOpenConnector appends the tools to whatever set it is given", async () => {
    await inAgent((a) => {
      const env = { OPEN_CONNECTOR_TOKEN: "x", OPEN_CONNECTOR_URL: "https://c.example" } as Env;
      expect(withOpenConnector(undefined, a.services, {} as Env)).toBeUndefined();
      const plain = withOpenConnector(undefined, a.services, env)!;
      expect(plain.connectors).toBe(true);
      expect(plain.tools.map((t) => t.name).slice(-5)).toEqual(["connected_apps", "search_actions", "action_guide", "run_action", "propose_action"]);
      const custom = withOpenConnector({ selectMemories: async () => [], tools: [ALL_TOOLS[0]!] }, a.services, env)!;
      expect(custom.tools).toHaveLength(6);
    });
  });

  it("guide extraction keeps the input table and the summary quotes inputs", () => {
    const md = "# x\n\n## Execute\n\ncurl …\n\n## Input Parameters\n\n| Name | Required |\n| `id` | No |\n\n## Required Scopes\n\nNone";
    expect(guideInputs(md)).toBe("## Input Parameters\n\n| Name | Required |\n| `id` | No |");
    expect(proposalSummary("notion.create_page", { title: "Plan", tags: ["a"] }, "work")).toBe("Run notion.create_page (work) — title: “Plan”, tags: [\"a\"]");
  });
});

describe("compactResult", () => {
  it("drops provider plumbing so real rows fit under the result cap", () => {
    const repo = { id: 1, name: "talorys", full_name: "x/talorys", private: false, html_url: "https://github.com/x/talorys", url: "https://api.github.com/repos/x/talorys", node_id: "R_1", description: null, topics: [], owner: { login: "x", avatar_url: "https://a", gravatar_id: "" }, license: {} };
    expect(compactResult(repo)).toEqual({ id: 1, name: "talorys", full_name: "x/talorys", private: false, owner: { login: "x" } });
    const repos = Array.from({ length: 3 }, (_, i) => ({ ...repo, name: `r${i}`, filler: "y".repeat(600), filler_url: "z".repeat(2000) }));
    const out = truncateResult({ repositories: repos }, 3500) as { repositories?: unknown[]; truncated?: boolean };
    expect(out.truncated).toBeUndefined();
    expect(out.repositories).toHaveLength(3);
  });
});

describe("action ids", () => {
  it("accepts dotted names like googledrive.files.list and reads the verb from the last segment", () => {
    const tool = openConnectorTools(new OpenConnectorClient({ url: "https://x", token: "t" })).find((t) => t.name === "run_action") as ImmediateTool;
    expect(tool.input.safeParse({ action: "googledrive.files.list", input: {} }).success).toBe(true);
    expect(tool.input.safeParse({ action: "googledrive", input: {} }).success).toBe(false);
    expect(isReadOnlyAction("googledrive.files.list")).toBe(true);
  });
});

describe("catalog fallback when the fuzzy search is cut off", () => {
  it("recognises the platform cut-off and hints services from the words", () => {
    expect(isPlatformLimitError(new Error("Worker exceeded CPU time limit."))).toBe(true);
    expect(isPlatformLimitError(new Error("OpenConnector answered 500: boom"))).toBe(false);
    expect(servicesHintedBy("what are my latest emails")).toEqual(["gmail"]);
    expect(servicesHintedBy("מה שלושת המיילים האחרונים שלי")).toEqual(["gmail"]);
    expect(servicesHintedBy("אילו ריפוזיטוריז יש לי בגיטהאב")).toEqual(["github"]);
    expect(servicesHintedBy("events in my calendar tomorrow")).toEqual(["googlecalendar"]);
  });
  it("ranks catalog rows by the query and reads inputs from the schema", () => {
    const rows = [
      { id: "gmail.add_label_to_email", description: "Add labels on a message." },
      { id: "gmail.search_threads", description: "Search Gmail threads by query.", inputSchema: { properties: { query: { type: "string", description: "Gmail search query." }, maxResults: { type: "integer" } }, required: ["query"] } },
      { id: "gmail.send_email", description: "Send an email." },
    ];
    const ranked = rankCatalogRows(rows, "search threads");
    expect(ranked[0]?.id).toBe("gmail.search_threads");
    expect(schemaInputLines(rows[1]?.inputSchema)).toEqual(["query (string, required): Gmail search query.", "maxResults (integer)"]);
  });
  it("search_actions falls back to per-service listings when OpenConnector is cut off", async () => {
    const calls: string[] = [];
    const binding = {
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        calls.push(url.pathname + url.search);
        if (url.pathname === "/mcp") {
          const body = (await req.json()) as { params: { name: string } };
          if (body.params.name === "search_actions") throw new Error("Worker exceeded CPU time limit.");
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true, data: [{ id: "gmail:default", service: "gmail" }] } } }), { headers: { "content-type": "application/json" } });
        }
        if (url.pathname === "/v1/actions" && url.searchParams.get("service") === "gmail") {
          return new Response(JSON.stringify({ success: true, data: [{ id: "gmail.search_threads", description: "Search Gmail threads by query.", inputSchema: { properties: { query: { type: "string" } }, required: ["query"] } }, { id: "gmail.send_email", description: "Send an email." }] }), { headers: { "content-type": "application/json" } });
        }
        return new Response("nope", { status: 404 });
      },
    } as unknown as Fetcher;
    const client = new OpenConnectorClient({ binding, token: "t" });
    const tool = openConnectorTools(client).find((t) => t.name === "search_actions") as ImmediateTool;
    const out = (await tool.execute({ query: "latest emails" }, {} as ToolContext)) as { actions: { id: string; inputs: string[] }[]; note: string };
    expect(out.actions.map((a) => a.id)).toEqual(["gmail.search_threads"]);
    expect(out.note).toContain("gmail");
    expect(calls.some((c) => c.startsWith("/v1/actions?service=gmail"))).toBe(true);
  });
});
