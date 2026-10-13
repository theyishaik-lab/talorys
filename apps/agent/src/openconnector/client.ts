import { NotConnectedError, ToolError } from "../tools/registry";
import { serviceDisplayName } from "./services";

/** Where tool results get cut before they reach the model (the free model has a small context). */
export const RESULT_CHARS = 3500;

/** The MCP tools OpenConnector exposes (see its docs/runtime-api.md). */
export type McpToolName = "list_apps" | "list_connections" | "search_actions" | "get_action_guide" | "execute_action";

export interface OpenConnectorConfig {
  /** Worker service binding to the `open-connector` Worker, when both run in one account. */
  binding?: Fetcher;
  /** Public URL of the OpenConnector deployment; used when no service binding is configured. */
  url?: string;
  /** OpenConnector runtime (agent) token. A Worker secret, never a var. */
  token: string;
}

interface McpResult {
  ok: boolean;
  data?: unknown;
  error?: unknown;
}

/**
 * A minimal client for OpenConnector's stateless MCP endpoint (`POST /mcp`, JSON-RPC over
 * HTTP). It only sends `tools/call`; OpenConnector does the catalog, credentials and provider
 * calls. Credentials never pass through here: the runtime token only grants Talorys the right
 * to run actions on connections the owner configured in the OpenConnector console.
 */
export class OpenConnectorClient {
  constructor(private readonly config: OpenConnectorConfig) {}

  /** Calls one MCP tool and returns its parsed `{ ok, data }` payload. */
  async call(name: McpToolName, args: Record<string, unknown>): Promise<McpResult> {
    const base = this.config.binding ? "https://open-connector" : (this.config.url ?? "").replace(/\/+$/, "");
    const fetcher = this.config.binding ?? { fetch: (req: Request) => fetch(req) };
    const request = new Request(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    let response: Response;
    try {
      response = await fetcher.fetch(request);
    } catch (error) {
      throw new ToolError(`OpenConnector is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.text();
    if (response.status === 401 || response.status === 403) throw new ToolError("OpenConnector rejected Talorys' runtime token. The owner must fix the connector setup.");
    if (!response.ok) throw new ToolError(`OpenConnector answered ${response.status}: ${body.slice(0, 200)}`);
    const rpc = parseRpc(body);
    if (rpc.error) throw new ToolError(`OpenConnector error: ${describe(rpc.error)}`);
    const result = (rpc.result ?? {}) as { structuredContent?: McpResult; content?: { type: string; text?: string }[]; isError?: boolean };
    if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    try {
      return JSON.parse(text) as McpResult;
    } catch {
      return { ok: !result.isError, data: text };
    }
  }

  /** Like `call`, but a `{ ok: false }` answer becomes a ToolError the model can read. */
  async data(name: McpToolName, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.call(name, args);
    if (!result.ok) {
      const service = notConnectedService(result.error, name === "execute_action" ? args.actionId : undefined);
      if (service) throw new NotConnectedError(service, serviceDisplayName(service));
      throw new ToolError(`OpenConnector could not complete ${name}: ${describe(result.error ?? result.data ?? "unknown error")}`);
    }
    return result.data;
  }

  /**
   * One of OpenConnector's plain runtime endpoints (`GET /v1/...`), which answer `{ success, data }`.
   * These read the catalog directly and cost 1-2 ms of CPU, where the MCP fuzzy search builds an
   * index over every catalog action and is cut off by the free plan's CPU limit when the call
   * comes from another Worker (measured Oct 13, 2026).
   */
  async get(path: string): Promise<unknown> {
    const base = this.config.binding ? "https://open-connector" : (this.config.url ?? "").replace(/\/+$/, "");
    const fetcher = this.config.binding ?? { fetch: (req: Request) => fetch(req) };
    let response: Response;
    try {
      response = await fetcher.fetch(new Request(`${base}${path}`, { headers: { authorization: `Bearer ${this.config.token}`, accept: "application/json" } }));
    } catch (error) {
      throw new ToolError(`OpenConnector is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const body = await response.text();
    if (response.status === 401 || response.status === 403) throw new ToolError("OpenConnector rejected Talorys' runtime token. The owner must fix the connector setup.");
    if (response.status === 404) throw new ToolError(`OpenConnector has no such action: ${path.slice(path.lastIndexOf("/") + 1)}`);
    if (!response.ok) throw new ToolError(`OpenConnector answered ${response.status}: ${body.slice(0, 200)}`);
    const parsed = JSON.parse(body) as { success?: boolean; message?: string; data?: unknown };
    if (parsed.success === false) throw new ToolError(`OpenConnector could not answer ${path}: ${parsed.message ?? "unknown error"}`);
    return parsed.data;
  }
}

/**
 * The service an action needs a connection for, read from OpenConnector's refusal: an
 * `authorization_failed` whose words are the connector's own "Connect googletasks with OAuth
 * first." / "Configure notion (API key | custom) credentials first." (seen live Oct 13, 2026), or
 * a `connection_not_found` error. Null for any other error, including a provider's own 401 on a
 * connection that exists. The action id supplies the service when the message does not name one.
 */
export function notConnectedService(error: unknown, actionId?: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  if (code !== "authorization_failed" && code !== "connection_not_found") return null;
  if (code === "authorization_failed" && !/^(connect|configure) \S+ (with oauth|(api key |custom )?credentials) first/i.test(text)) return null;
  const named = text.match(/^(?:connect|configure) ([a-z0-9_]+) |^([a-z0-9_]+) connection not found/i);
  const fromMessage = (named?.[1] ?? named?.[2])?.toLowerCase();
  const fromAction = typeof actionId === "string" && actionId.includes(".") ? actionId.slice(0, actionId.indexOf(".")).toLowerCase() : undefined;
  return fromMessage ?? fromAction ?? null;
}

/** The words of a CPU-limit or similar platform cut-off, as the error reaches us. */
export function isPlatformLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CPU time limit|exceeded CPU|Worker exceeded|1102|resource limit|empty response/i.test(message);
}

/** Services a free-text query points at, so a failed catalog search can fall back to per-service listings. */
export function servicesHintedBy(query: string): string[] {
  const q = query.toLowerCase();
  const hints: [RegExp, string][] = [
    [/gmail|e-?mail|mail|inbox|\u05de\u05d9\u05d9\u05dc|\u05d2['\u05f3]?\u05d9\u05de\u05d9\u05d9\u05dc|\u05d3\u05d5\u05d0\u05e8/, "gmail"],
    [/calendar|event|meeting|\u05d9\u05d5\u05de\u05df|\u05e4\u05d2\u05d9\u05e9|\u05d0\u05d9\u05e8\u05d5\u05e2/, "googlecalendar"],
    [/drive|file|folder|document|\u05d3\u05e8\u05d9\u05d9\u05d1|\u05e7\u05d5\u05d1\u05e5|\u05de\u05e1\u05de\u05da/, "googledrive"],
    [/github|repo|repositor|issue|pull request|\u05d2\u05d9\u05d8\u05d4\u05d0\u05d1|\u05e8\u05d9\u05e4\u05d5/, "github"],
    [/sheet|spreadsheet|\u05d2\u05d9\u05dc\u05d9\u05d5\u05df/, "googlesheets"],
    [/docs?\b|google doc/, "googledocs"],
    [/task|todo|\u05de\u05e9\u05d9\u05de/, "googletasks"],
    [/arxiv|paper/, "arxiv"],
    [/hacker ?news|\bhn\b/, "hackernews"],
  ];
  return hints.filter(([re]) => re.test(q)).map(([, service]) => service);
}

/** The endpoint answers JSON or a one-event SSE body depending on the Accept negotiation. */
function parseRpc(body: string): { result?: unknown; error?: unknown } {
  const trimmed = body.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const data = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  const last = data.at(-1);
  if (!last) throw new ToolError("OpenConnector returned an empty response.");
  return JSON.parse(last);
}

/** A short, model-readable rendering of an error payload. */
export function describe(error: unknown): string {
  if (typeof error === "string") return error.slice(0, 300);
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; code?: unknown; error?: unknown; details?: unknown };
    if (typeof e.message === "string") {
      // Schema failures carry the actual reason ("…required property \"calendarId\"") in details;
      // without it the model only reads "does not match the action schema" and retries blind.
      const reasons = Array.isArray(e.details)
        ? e.details
            .map((d) => (d && typeof d === "object" && typeof (d as { error?: unknown }).error === "string" ? ((d as { error: string }).error) : ""))
            .filter(Boolean)
            .slice(0, 3)
        : [];
      const head = `${typeof e.code === "string" ? `${e.code}: ` : ""}${e.message}`;
      return (reasons.length ? `${head} ${reasons.join(" ")}` : head).slice(0, 300);
    }
    if (e.error !== undefined) return describe(e.error);
  }
  return JSON.stringify(error)?.slice(0, 300) ?? "unknown error";
}

/** Keys that carry provider plumbing (API links, opaque ids, etags) rather than facts the model needs. */
const NOISE_KEY = /(^|_)(url|urls|node_id|gravatar_id|etag|self_link|selflink|kind|resource_id|resourceid)$/i;

/**
 * Strips provider noise before a result is measured against RESULT_CHARS: nulls, empty
 * containers, API-link fields and ids the model cannot act on. A GitHub repository object is
 * ~6 KB raw and ~400 B compacted, so a list of three fits where one did not. Facts are never
 * rewritten, only omitted.
 */
export function compactResult(value: unknown, depth = 0): unknown {
  if (depth > 12) return value;
  if (Array.isArray(value)) return value.map((v) => compactResult(v, depth + 1)).filter((v) => v !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined || NOISE_KEY.test(k)) continue;
      const c = compactResult(v, depth + 1);
      if (c === undefined) continue;
      if (Array.isArray(c) && c.length === 0) continue;
      if (c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 0) continue;
      out[k] = c;
    }
    return out;
  }
  return value;
}

/** Cuts a result the model would otherwise drown in; the note tells it what happened. */
export function truncateResult(value: unknown, max = RESULT_CHARS): unknown {
  const compact = compactResult(value);
  const text = JSON.stringify(compact);
  if (text === undefined || text.length <= max) return compact;
  return { truncated: true, note: `Result cut to ${max} of ${text.length} characters. Ask for something narrower if the part you need is missing.`, text: text.slice(0, max) };
}
