import type { ConnectCard, ConnectField } from "@talorys/shared";
import { z } from "zod";
import { defineTool, ToolError, type ToolContext, type ToolDefinition } from "../tools/registry";
import { describe, type OpenConnectorClient } from "./client";

/**
 * Connecting a new app from inside the chat ("agent self-connect").
 *
 * The agent only ever proposes (`connect_service` is a destructive tool, so it goes through the
 * owner's Approve button like every other change). The privileged OpenConnector admin calls —
 * minting a consent link, storing an API key — run in this Worker after the approval, with the
 * admin token the model never sees. An API key the owner types reaches `commit` straight from the
 * approve request and is forwarded to OpenConnector; Talorys never stores, logs or echoes it.
 */

/** The admin side of OpenConnector: catalog reads plus the two connection writes this feature needs. */
export interface OpenConnectorAdminConfig {
  url: string;
  /** OpenConnector admin token. A Worker secret; it is never part of a tool result. */
  adminToken: string;
  /** Tests inject a fake Worker here; production uses global fetch over the public URL. */
  fetcher?: { fetch(request: Request): Promise<Response> };
}

interface ProviderAuth {
  type: "oauth2" | "api_key" | "custom_credential" | "no_auth" | string;
  label?: string;
  placeholder?: string;
  description?: string;
  fields?: ProviderField[];
  extraFields?: ProviderField[];
}

interface ProviderField {
  key: string;
  label?: string;
  placeholder?: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
  inputType?: string;
}

export interface ProviderInfo {
  service: string;
  displayName?: string;
  categories?: string[];
  authTypes?: string[];
  auth?: ProviderAuth[];
  homepageUrl?: string;
}

interface ConnectionProfile {
  service?: string;
  authType?: string;
  connectionName?: string;
  profile?: { displayName?: string; accountId?: string };
}

export class OpenConnectorAdmin {
  constructor(private readonly config: OpenConnectorAdminConfig) {}

  private async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    const base = this.config.url.replace(/\/+$/, "");
    let response: Response;
    const request = new Request(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${this.config.adminToken}`,
        accept: "application/json",
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    try {
      response = await (this.config.fetcher ?? { fetch: (r: Request) => fetch(r) }).fetch(request);
    } catch (error) {
      throw new ToolError(`OpenConnector is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401 || response.status === 403) throw new ToolError("OpenConnector rejected the connector's admin token. The owner must fix the connector setup.");
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  }

  /** One provider's catalog entry (auth options, name), or null when the id is unknown. */
  async provider(service: string): Promise<ProviderInfo | null> {
    const { status, body } = await this.request(`/api/providers/${encodeURIComponent(service)}`);
    if (status === 404) return null;
    if (status !== 200 || !body || typeof body !== "object") throw new ToolError(`OpenConnector answered ${status} for the ${service} catalog entry.`);
    const info = body as ProviderInfo;
    // Only the fields we read; the actions list is tens of KB per provider.
    return { service: info.service, displayName: info.displayName, categories: info.categories, authTypes: info.authTypes, auth: info.auth, homepageUrl: info.homepageUrl };
  }

  /** Whether an OAuth client (client id + secret) is stored for the service. */
  async oauthConfigured(service: string): Promise<boolean> {
    const { status, body } = await this.request("/api/oauth/configs");
    if (status !== 200 || !Array.isArray(body)) throw new ToolError(`OpenConnector answered ${status} for the OAuth client list.`);
    // Configured entries sort first, so the scan stops at the first unconfigured one.
    for (const row of body as { service?: string; configured?: boolean }[]) {
      if (row.configured === false) break;
      if (row.service === service) return true;
    }
    return false;
  }

  /** The services connected with an account (virtual public ones excluded). */
  async connections(service?: string): Promise<ConnectionProfile[]> {
    const { status, body } = await this.request("/api/connections");
    if (status !== 200 || !Array.isArray(body)) throw new ToolError(`OpenConnector answered ${status} for the connection list.`);
    return (body as ConnectionProfile[]).filter((c) => c.authType && c.authType !== "no_auth" && (!service || c.service === service));
  }

  /** Mints the provider's consent link for the default connection. */
  async startOAuth(service: string): Promise<string> {
    const { status, body } = await this.request("/api/oauth/authorizations", { method: "POST", body: { service } });
    const url = body && typeof body === "object" ? (body as { authorizationUrl?: unknown }).authorizationUrl : undefined;
    if (status === 200 && typeof url === "string" && /^https:\/\//.test(url)) return url;
    throw new ToolError(`OpenConnector could not start the sign-in: ${describeError(body) || `status ${status}`}`);
  }

  /**
   * Stores (or replaces) the default connection of a service from the values the owner typed.
   * OpenConnector validates them against the provider before saving; a bad key is a 400 here.
   */
  async storeCredential(service: string, authType: "api_key" | "custom_credential", values: Record<string, string>): Promise<ConnectionProfile> {
    const { status, body } = await this.request(`/api/connections/${encodeURIComponent(service)}`, { method: "PUT", body: { authType, values } });
    if (status === 200 && body && typeof body === "object") return body as ConnectionProfile;
    throw new ToolError(`${describeError(body) || `OpenConnector answered ${status}`}`);
  }
}

function describeError(body: unknown): string {
  if (!body || typeof body !== "object") return typeof body === "string" ? body.slice(0, 200) : "";
  const e = (body as { error?: unknown }).error;
  return e ? describe(e) : "";
}

export { KNOWN_SERVICES, resolveServiceIds, searchKnownServices, type KnownService } from "./services";
import { KNOWN_SERVICES, resolveServiceIds, searchKnownServices } from "./services";

/** The fields the owner types for a key-based connection, from the provider's auth definition. */
export function credentialFields(auth: ProviderAuth): ConnectField[] {
  const toField = (f: ProviderField, fallbackLabel: string): ConnectField => ({
    key: f.key,
    label: f.label ?? fallbackLabel,
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    ...(f.description ? { hint: f.description.slice(0, 300) } : {}),
    secret: f.secret ?? f.inputType !== "text",
    required: f.required ?? true,
  });
  if (auth.type === "api_key") {
    return [
      { key: "apiKey", label: auth.label ?? "API key", ...(auth.placeholder ? { placeholder: auth.placeholder } : {}), ...(auth.description ? { hint: auth.description.slice(0, 300) } : {}), secret: true, required: true },
      ...(auth.extraFields ?? []).map((f) => toField(f, f.key)),
    ];
  }
  return (auth.fields ?? []).map((f) => toField(f, f.key));
}

/** How a provider can be connected here, in the order the owner would prefer. */
export interface ConnectPlan {
  method: "oauth" | "api_key" | "custom_credential";
  /** oauth only: the client is stored, so a consent link can be minted. */
  oauthReady?: boolean;
  fields?: ConnectField[];
}

/**
 * Picks the connection method: OAuth when its client is configured (one tap for the owner), else
 * a key the owner pastes, else OAuth that still needs its app registered (reported, not attempted).
 */
export async function planConnection(admin: OpenConnectorAdmin, provider: ProviderInfo): Promise<ConnectPlan> {
  const auth = provider.auth ?? [];
  const oauth = auth.find((a) => a.type === "oauth2");
  const apiKey = auth.find((a) => a.type === "api_key");
  const custom = auth.find((a) => a.type === "custom_credential");
  if (oauth && (await admin.oauthConfigured(provider.service))) return { method: "oauth", oauthReady: true };
  if (apiKey) return { method: "api_key", fields: credentialFields(apiKey) };
  if (custom) return { method: "custom_credential", fields: credentialFields(custom) };
  if (oauth) return { method: "oauth", oauthReady: false };
  throw new ToolError(`${provider.displayName ?? provider.service} has no login method Talorys can set up.`);
}

/** What a stored proposal replays on approval. */
export interface ConnectTarget {
  service: string;
  name: string;
  method: "oauth" | "api_key" | "custom_credential";
  fieldKeys: string[];
}

const SETUP_NOTE = (name: string) =>
  `${name} needs a one-time setup before it can be connected from here: its OAuth app must be registered with the provider and its client id and secret saved in the OpenConnector console. Tell the owner plainly; do not retry.`;

/** The agent's connect tools. Both need the admin side; without it the agent cannot connect apps. */
export function connectTools(admin: OpenConnectorAdmin, runtime: OpenConnectorClient): ToolDefinition[] {
  const known = (id: string) => KNOWN_SERVICES.find((s) => s.id === id);

  async function findProvider(text: string): Promise<ProviderInfo> {
    const ids = resolveServiceIds(text);
    for (const id of ids) {
      const info = await admin.provider(id);
      if (info) return info;
    }
    const suggestions = searchKnownServices(text, 5).map((s) => `${s.id} (${s.name})`);
    throw new ToolError(
      `No app matches "${text.slice(0, 60)}". ${suggestions.length ? `Did you mean: ${suggestions.join(", ")}?` : "Use list_connectable_services to see the ids."} Use the service id from list_connectable_services.`,
    );
  }

  return [
    defineTool({
      name: "list_connectable_services",
      description:
        "Which external apps can be connected to Talorys from the chat (Google Tasks, Sheets, Docs, Notion, Slack, Todoist, Trello and more), and which are already connected. Use it when the owner wants to add or connect an app, or asks what can be connected. Optional query filters by name (any language).",
      permission: "read",
      maxCallsPerTurn: 2,
      input: z.object({ query: z.string().trim().max(80).optional().describe("App name to look for, e.g. 'google tasks' or 'נושן'") }),
      label: (i) => (i.query ? `Looking up ${i.query}` : "Listing connectable apps"),
      execute: async (i) => {
        const connected = new Map<string, string>();
        try {
          const rows = (await runtime.data("list_connections", {})) as unknown;
          for (const c of Array.isArray(rows) ? (rows as ConnectionProfile[]) : []) {
            if (c.service && c.authType && c.authType !== "no_auth") connected.set(c.service, c.profile?.displayName ?? c.profile?.accountId ?? "connected");
          }
        } catch {
          // The list still helps without live status.
        }
        const hits = searchKnownServices(i.query);
        const services = hits.map((s) => ({ service: s.id, name: s.name, name_he: s.he, ...(connected.has(s.id) ? { connected_as: connected.get(s.id) } : {}) }));
        const firstId = i.query ? resolveServiceIds(i.query)[0] : undefined;
        if (i.query && hits.length === 0 && firstId) {
          const info = await admin.provider(firstId);
          if (info) services.push({ service: info.service, name: info.displayName ?? info.service, name_he: info.displayName ?? info.service, ...(connected.has(info.service) ? { connected_as: connected.get(info.service) } : {}) });
        }
        // The owner named one app and it is not connected: the executor attaches its connect card to this step.
        const only = i.query && services.length === 1 ? services[0] : undefined;
        const missing = only && !only.connected_as ? { service: only.service, name: only.name } : undefined;
        return {
          services,
          note:
            services.length === 0
              ? "No known app matches. Try connect_service with the app's name anyway; the catalog has ~1,400 providers."
              : "To connect one, call connect_service with its service id. The owner approves on a card; keys are typed on that card, never in chat.",
          ...(missing ? { connect_card: missing } : {}),
        };
      },
    }),
    defineTool({
      name: "connect_service",
      description:
        "Propose connecting an external app to Talorys (e.g. service 'googletasks', 'googlesheets', 'notion', 'todoist'). The owner sees a card with an Approve button: Google and other OAuth apps then open a sign-in link; API-key apps show a secure field on the card. Never ask the owner to paste a key or password into the chat.",
      permission: "destructive",
      input: z.object({ service: z.string().trim().min(2).max(80).describe("Service id from list_connectable_services, or the app's name") }),
      label: (i) => `Proposing to connect ${i.service}`,
      prepare: async (i) => {
        const provider = await findProvider(i.service);
        const name = provider.displayName ?? known(provider.service)?.name ?? provider.service;
        const already = await connectionStatus(runtime, provider.service).catch(() => ({ connected: false, account: null }));
        const plan = await planConnection(admin, provider);
        if (plan.method === "oauth" && !plan.oauthReady) throw new ToolError(SETUP_NOTE(name));
        const target: ConnectTarget = { service: provider.service, name, method: plan.method, fieldKeys: (plan.fields ?? []).map((f) => f.key) };
        const card: ConnectCard = {
          kind: "connect",
          service: provider.service,
          name,
          method: plan.method === "oauth" ? "oauth" : "api_key",
          ...(plan.fields ? { fields: plan.fields } : {}),
        };
        const reconnect = already.connected ? ` (replaces the current connection${already.account ? ` as ${already.account}` : ""})` : "";
        return {
          targetId: JSON.stringify(target),
          summary: `Connect ${name}${reconnect}`,
          card,
          note:
            plan.method === "oauth"
              ? `Nothing is connected yet. The owner sees a card to approve connecting ${name}; after approving they open a sign-in link, consent, and come back. Tell them that in one or two sentences, in their language. Do not call this tool again for ${name} and do not claim it is connected; connected_apps will show it once they finish.`
              : `Nothing is connected yet. The owner sees a card for ${name} with a secure field for its ${plan.fields?.map((f) => f.label).join(", ") ?? "key"} and an Approve button. Tell them to fill the key on the card (never in the chat) and approve. Do not call this tool again for ${name} and do not claim it is connected.`,
        };
      },
      commit: async (targetId, ctx: ToolContext, submitted) => {
        const target = JSON.parse(targetId) as ConnectTarget;
        if (target.method === "oauth") {
          const url = await admin.startOAuth(target.service);
          ctx.services.activity.record("connector.connect", `Sign-in link opened for ${target.name}`);
          return { card: { kind: "connect", service: target.service, name: target.name, method: "oauth", authorization_url: url } satisfies ConnectCard };
        }
        const values: Record<string, string> = {};
        for (const key of target.fieldKeys) {
          const v = submitted?.[key];
          if (typeof v === "string" && v.trim()) values[key] = v.trim();
        }
        if (Object.keys(values).length === 0) throw new ToolError("The key was not filled in. Approve again with the field filled.");
        const profile = await admin.storeCredential(target.service, target.method, values);
        const account = profile.profile?.displayName ?? profile.profile?.accountId ?? "";
        ctx.services.activity.record("connector.connect", `${target.name} connected${account ? ` as ${account}` : ""}`);
        ctx.services.notifications.create({ title: "Connected", body: `${target.name} is connected${account ? ` as ${account}` : ""}. Ask me to use it.`, kind: "result" });
        return { card: { kind: "connect", service: target.service, name: target.name, method: "api_key", account: account || "connected" } satisfies ConnectCard };
      },
    }),
  ] as ToolDefinition[];
}

/**
 * A fresh consent link for an already-approved OAuth connect action. OpenConnector's OAuth state
 * lives 15 minutes, so a card the owner opens later would carry a dead link; the card asks for a
 * new one when it is shown. Only an approved `connect_service` action with an OAuth card qualifies:
 * the approval was for exactly this app, and minting a link changes nothing until the owner consents.
 */
export async function refreshConnectLink(admin: OpenConnectorAdmin, ctx: ToolContext, actionId: string): Promise<string> {
  const pending = ctx.services.pendingActions;
  const stored = pending.get(actionId);
  const card = stored ? pending.view(actionId)?.card : undefined;
  if (!stored || stored.tool !== "connect_service" || !card || card.method !== "oauth") throw new ToolError("This action has no sign-in link.");
  if (stored.status !== "approved") throw new ToolError("This connection was not approved.");
  const url = await admin.startOAuth(card.service);
  pending.setCard(actionId, { ...card, authorization_url: url });
  return url;
}

/** Whether a service is connected now (polled by the card after an OAuth sign-in). Uses the runtime token, like the agent. */
export async function connectionStatus(runtime: OpenConnectorClient, service: string): Promise<{ connected: boolean; account: string | null }> {
  const rows = (await runtime.data("list_connections", { service })) as ConnectionProfile[] | unknown;
  const list = Array.isArray(rows) ? (rows as ConnectionProfile[]) : [];
  const row = list.find((c) => c.service === service && c.authType && c.authType !== "no_auth");
  return { connected: !!row, account: row ? (row.profile?.displayName ?? row.profile?.accountId ?? null) : null };
}
