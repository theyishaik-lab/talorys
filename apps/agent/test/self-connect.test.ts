import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import type { Env } from "../src/env";
import { OpenConnectorClient, toolsWithOpenConnector } from "../src/openconnector";
import { connectionStatus, connectTools, credentialFields, KNOWN_SERVICES, OpenConnectorAdmin, resolveServiceIds, searchKnownServices } from "../src/openconnector/connect";
import { ALL_TOOLS, runApprovedAction, ToolExecutor, type ToolContext } from "../src/tools";
import type { DestructiveTool, ImmediateTool } from "../src/tools/registry";

interface AdminCall {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

const PROVIDERS: Record<string, unknown> = {
  googletasks: { service: "googletasks", displayName: "Google Tasks", authTypes: ["oauth2"], auth: [{ type: "oauth2", scopes: ["tasks"] }], actions: [{ id: "x" }] },
  slack: { service: "slack", displayName: "Slack", authTypes: ["oauth2"], auth: [{ type: "oauth2", scopes: ["chat:write"] }] },
  notion: {
    service: "notion",
    displayName: "Notion",
    authTypes: ["oauth2", "api_key"],
    auth: [
      { type: "oauth2", scopes: ["read_content"] },
      { type: "api_key", label: "Internal Integration Secret", placeholder: "secret_...", description: "Create an internal integration and share pages with it." },
    ],
  },
  trello: {
    service: "trello",
    displayName: "Trello",
    authTypes: ["custom_credential"],
    auth: [{ type: "custom_credential", fields: [{ key: "apiKey", label: "API Key", inputType: "password", required: true, secret: true }, { key: "apiToken", label: "API Token", inputType: "password", required: true, secret: true }] }],
  },
};

/** A fake OpenConnector admin API + runtime MCP endpoint, recording every call. */
function fakeAdmin(opts: { configured?: string[]; connections?: { service: string; authType: string; profile?: { displayName?: string } }[]; keyRejected?: boolean } = {}) {
  const calls: AdminCall[] = [];
  const connections = [...(opts.connections ?? [])];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = {
    fetch: async (req: Request) => {
      const url = new URL(req.url);
      const body = req.method === "GET" ? undefined : await req.json();
      calls.push({ method: req.method, path: url.pathname, body, authorization: req.headers.get("authorization") });
      if (url.pathname === "/mcp") {
        const params = (body as { params: { name: string; arguments: { service?: string } } }).params;
        if (params.name !== "list_connections") return json(200, { jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: false, error: "nope" } } });
        const rows = connections.filter((c) => !params.arguments.service || c.service === params.arguments.service);
        return json(200, { jsonrpc: "2.0", id: 1, result: { structuredContent: { ok: true, data: rows } } });
      }
      const provider = url.pathname.match(/^\/api\/providers\/([^/]+)$/);
      if (provider) return PROVIDERS[provider[1]!] ? json(200, PROVIDERS[provider[1]!]) : json(404, { error: { code: "not_found", message: "Unknown provider" } });
      if (url.pathname === "/api/oauth/configs") {
        const configured = opts.configured ?? [];
        return json(200, [...configured.map((s) => ({ service: s, configured: true })), { service: "slack", configured: false }, { service: "notion", configured: false }]);
      }
      if (url.pathname === "/api/connections" && req.method === "GET") return json(200, connections);
      if (url.pathname === "/api/oauth/authorizations") return json(200, { authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?state=abc&service=${(body as { service: string }).service}` });
      const put = url.pathname.match(/^\/api\/connections\/([^/]+)$/);
      if (put && req.method === "PUT") {
        if (opts.keyRejected) return json(400, { error: { code: "credential_verification_failed", message: "notion request failed with status 401" } });
        const row = { id: `${put[1]}:default`, service: put[1]!, connectionName: "default", authType: (body as { authType: string }).authType, profile: { displayName: "Yishai's workspace" } };
        connections.push(row);
        return json(200, row);
      }
      return json(404, { error: { code: "not_found", message: `no route ${url.pathname}` } });
    },
  };
  const admin = new OpenConnectorAdmin({ url: "https://connector.example", adminToken: "adm_secret", fetcher });
  const runtime = new OpenConnectorClient({ url: "https://connector.example", token: "rt_test", binding: fetcher as unknown as Fetcher });
  return { admin, runtime, calls, tools: connectTools(admin, runtime) };
}

const immediate = (tools: ReturnType<typeof connectTools>, name: string) => tools.find((t) => t.name === name)! as ImmediateTool;
const destructive = (tools: ReturnType<typeof connectTools>, name: string) => tools.find((t) => t.name === name)! as DestructiveTool;
const ctx = (s: ToolContext["services"], conversationId?: string): ToolContext => ({ services: s, timezone: "UTC", mode: "chat", conversationId });

describe("service name resolution", () => {
  it("maps English, Hebrew and catalog-style names to catalog ids", () => {
    expect(resolveServiceIds("Google Tasks")[0]).toBe("googletasks");
    expect(resolveServiceIds("google_tasks")[0]).toBe("googletasks");
    expect(resolveServiceIds("משימות גוגל")[0]).toBe("googletasks");
    expect(resolveServiceIds("גוגל שיטס")[0]).toBe("googlesheets");
    expect(resolveServiceIds("נושן")[0]).toBe("notion");
    expect(resolveServiceIds("notion")).toEqual(["notion"]);
    expect(resolveServiceIds("some_unknown_app")).toEqual(["some_unknown_app", "someunknownapp"]);
    expect(resolveServiceIds("   ")).toEqual([]);
  });

  it("searches the known list by any name and lists everything without a query", () => {
    expect(searchKnownServices("גיליון").map((s) => s.id)).toEqual(["googlesheets"]);
    expect(searchKnownServices("todo").map((s) => s.id)).toContain("todoist");
    expect(searchKnownServices(undefined)).toHaveLength(12);
    expect(new Set(KNOWN_SERVICES.map((s) => s.id)).size).toBe(KNOWN_SERVICES.length);
  });

  it("turns a provider's auth definition into the card's fields", () => {
    expect(credentialFields({ type: "api_key", label: "Token", placeholder: "tok_", extraFields: [{ key: "workspace", label: "Workspace", inputType: "text", required: false }] })).toEqual([
      { key: "apiKey", label: "Token", placeholder: "tok_", secret: true, required: true },
      { key: "workspace", label: "Workspace", secret: false, required: false },
    ]);
    expect(credentialFields({ type: "custom_credential", fields: [{ key: "apiToken", label: "API Token", inputType: "password", required: true, secret: true, description: "From the admin page" }] })).toEqual([
      { key: "apiToken", label: "API Token", hint: "From the admin page", secret: true, required: true },
    ]);
  });
});

describe("connect tools", () => {
  it("are registered only when the admin token and the URL are configured", () => {
    const base = ALL_TOOLS.length;
    expect(toolsWithOpenConnector({ OPEN_CONNECTOR_TOKEN: "x", OPEN_CONNECTOR_URL: "https://c.example" } as Env)).toHaveLength(base + 5);
    expect(toolsWithOpenConnector({ OPEN_CONNECTOR_TOKEN: "x", OPEN_CONNECTOR_URL: "https://c.example", OPEN_CONNECTOR_ADMIN_TOKEN: "adm" } as Env).map((t) => t.name)).toEqual(
      expect.arrayContaining(["list_connectable_services", "connect_service"]),
    );
    expect(toolsWithOpenConnector({ OPEN_CONNECTOR_TOKEN: "x", OPEN_CONNECTOR: {} as Fetcher, OPEN_CONNECTOR_ADMIN_TOKEN: "adm" } as Env)).toHaveLength(base + 5);
  });

  it("list_connectable_services names apps in English and Hebrew with their connection state", async () => {
    const { tools, calls } = fakeAdmin({ connections: [{ service: "gmail", authType: "oauth2", profile: { displayName: "yishai@example.com" } }] });
    await inAgent(async (a) => {
      const all = (await immediate(tools, "list_connectable_services").execute({}, ctx(a.services))) as { services: { service: string; name_he: string; connected_as?: string }[] };
      expect(all.services.find((s) => s.service === "gmail")).toEqual({ service: "gmail", name: "Gmail", name_he: "ג'ימייל", connected_as: "yishai@example.com" });
      expect(all.services.find((s) => s.service === "googletasks")?.connected_as).toBeUndefined();
      const one = (await immediate(tools, "list_connectable_services").execute({ query: "משימות" }, ctx(a.services))) as { services: { service: string }[] };
      expect(one.services.map((s) => s.service)).toEqual(["googletasks"]);
      // Status comes from the runtime token, not the admin token.
      expect(calls.every((c) => c.path === "/mcp" && c.authorization === "Bearer rt_test")).toBe(true);
    });
  });

  it("connect_service for a configured OAuth app proposes, and the consent link is minted only on approval", async () => {
    const { tools, calls } = fakeAdmin({ configured: ["gmail", "googletasks"] });
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const executor = new ToolExecutor([...ALL_TOOLS, ...tools], ctx(s, conversation.id), { maxToolCalls: 5 });
      const proposed = (await executor.execute("connect_service", { service: "Google Tasks" }, "call-1")) as { status: string; note: string };
      expect(proposed.status).toBe("awaiting_owner_approval");
      expect(proposed.note).toContain("sign-in link");
      expect(calls.some((c) => c.path === "/api/oauth/authorizations")).toBe(false);
      const pending = executor.approvalFor("call-1")!;
      expect(pending.summary).toBe("Connect Google Tasks");
      expect(pending.card).toEqual({ kind: "connect", service: "googletasks", name: "Google Tasks", method: "oauth" });
      // The card is stored with the action and survives a reload.
      expect(s.pendingActions.view(pending.id)?.card?.method).toBe("oauth");

      const done = await runApprovedAction([...ALL_TOOLS, ...tools], ctx(s), pending.id);
      expect(done.status).toBe("approved");
      expect(done.card?.authorization_url).toMatch(/^https:\/\/accounts\.google\.com\/.*service=googletasks/);
      const mint = calls.find((c) => c.path === "/api/oauth/authorizations")!;
      expect(mint).toMatchObject({ method: "POST", body: { service: "googletasks" }, authorization: "Bearer adm_secret" });
      // The model-facing result never carried the admin token or the link.
      expect(JSON.stringify(proposed)).not.toContain("adm_secret");
    });
  });

  it("an OAuth app without a registered client is reported as needing a one-time setup, not attempted", async () => {
    const { tools, calls } = fakeAdmin({ configured: ["gmail"] });
    await inAgent(async (a) => {
      await expect(destructive(tools, "connect_service").prepare({ service: "slack" }, ctx(a.services, "c1"))).rejects.toThrow(/Slack needs a one-time setup/);
      expect(calls.some((c) => c.path === "/api/oauth/authorizations")).toBe(false);
    });
  });

  it("an API-key app shows secret fields on the card; the typed key goes only to the connector on approval", async () => {
    const { tools, calls } = fakeAdmin({ configured: ["gmail"] });
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const executor = new ToolExecutor([...ALL_TOOLS, ...tools], ctx(s, conversation.id), { maxToolCalls: 5 });
      const proposed = (await executor.execute("connect_service", { service: "נושן" }, "call-1")) as { note: string };
      expect(proposed.note).toContain("never in the chat");
      const pending = executor.approvalFor("call-1")!;
      expect(pending.card).toMatchObject({ method: "api_key", name: "Notion", fields: [{ key: "apiKey", label: "Internal Integration Secret", placeholder: "secret_...", secret: true, required: true }] });

      // Approving without the key changes nothing.
      const empty = await runApprovedAction([...ALL_TOOLS, ...tools], ctx(s), pending.id);
      expect(empty.status).toBe("failed");
      expect(calls.some((c) => c.method === "PUT")).toBe(false);

      const again = (await destructive(tools, "connect_service").prepare({ service: "notion" }, ctx(s, conversation.id)));
      const second = s.pendingActions.create({ conversation_id: conversation.id, tool: "connect_service", target_id: again.targetId, summary: again.summary, card: again.card });
      const done = await runApprovedAction([...ALL_TOOLS, ...tools], ctx(s), second.id, { apiKey: "secret_abc123", junk: "ignored" });
      expect(done.status).toBe("approved");
      expect(done.card).toEqual({ kind: "connect", service: "notion", name: "Notion", method: "api_key", account: "Yishai's workspace" });
      const put = calls.find((c) => c.method === "PUT")!;
      expect(put).toMatchObject({ path: "/api/connections/notion", body: { authType: "api_key", values: { apiKey: "secret_abc123" } }, authorization: "Bearer adm_secret" });
      // The key is nowhere in Talorys' own records.
      expect(JSON.stringify(s.pendingActions.view(second.id))).not.toContain("secret_abc123");
      expect(JSON.stringify(s.notifications.list({ limit: 5 }))).not.toContain("secret_abc123");
      expect(s.notifications.list({ limit: 1 })[0]?.body).toContain("Notion is connected");
    });
  });

  it("a rejected key marks the action failed with the connector's reason", async () => {
    const { tools } = fakeAdmin({ keyRejected: true });
    await inAgent(async (a) => {
      const s = a.services;
      const conversation = s.conversations.create("test");
      const prepared = await destructive(tools, "connect_service").prepare({ service: "trello" }, ctx(s, conversation.id));
      expect(prepared.card?.fields?.map((f) => f.key)).toEqual(["apiKey", "apiToken"]);
      const pending = s.pendingActions.create({ conversation_id: conversation.id, tool: "connect_service", target_id: prepared.targetId, summary: prepared.summary, card: prepared.card });
      const done = await runApprovedAction([...ALL_TOOLS, ...tools], ctx(s), pending.id, { apiKey: "k", apiToken: "t" });
      expect(done.status).toBe("failed");
      expect(done.error).toContain("credential_verification_failed");
    });
  });

  it("an unknown app gets suggestions instead of a connector call", async () => {
    const { tools, calls } = fakeAdmin();
    await inAgent(async (a) => {
      await expect(destructive(tools, "connect_service").prepare({ service: "frobnicator" }, ctx(a.services, "c1"))).rejects.toThrow(/No app matches/);
      expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
    });
  });

  it("the status route answers 404 without a connector and rejects odd service ids", async () => {
    const c = await loggedIn();
    expect((await c.call("/api/connections/googletasks")).status).toBe(404);
    expect((await c.call("/api/connections/..%2Fadmin")).status).toBe(404);
  });

  it("connectionStatus reads the runtime's connection list", async () => {
    const { runtime } = fakeAdmin({ connections: [{ service: "googletasks", authType: "oauth2", profile: { displayName: "OAuth Credential" } }] });
    expect(await connectionStatus(runtime, "googletasks")).toEqual({ connected: true, account: "OAuth Credential" });
    expect(await connectionStatus(runtime, "notion")).toEqual({ connected: false, account: null });
  });
});
