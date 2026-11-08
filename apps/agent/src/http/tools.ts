import { z } from "zod";
import { defineTool, type PreparedAction, type ToolContext, ToolError, type ToolDefinition } from "../tools/registry";
import type { ApiConnection } from "./connections";
import { buildRequest, displayUrl, HTTP_METHODS, type HttpMethod, type HttpRequestSpec, type HttpResult, HttpToolError, MAX_REQUEST_BODY_CHARS, MAX_TIMEOUT_MS, sendRequest } from "./request";

export const HTTP_TOOL = "http_request";

const inputSchema = z.object({
  method: z.enum(HTTP_METHODS).default("GET").describe("HTTP method. GET reads; anything else changes data and may wait for the owner's approval."),
  url: z.string().trim().min(1).max(2000).describe("Full https:// URL, or — when `connection` is given — a path under the connection's base URL, e.g. /v1/forecast"),
  connection: z.string().trim().min(1).max(60).optional().describe("Name of a saved API connection (Settings → API connections). Its key is added for you; never put keys in headers or the URL yourself."),
  query: z.record(z.string(), z.unknown()).optional().describe("Query-string parameters, e.g. {\"city\": \"Tel Aviv\"}"),
  headers: z.record(z.string(), z.string()).optional().describe("Extra request headers"),
  json: z.record(z.string(), z.unknown()).optional().describe("JSON body (an object), sent as application/json. Not for GET."),
  body: z.string().max(MAX_REQUEST_BODY_CHARS).optional().describe("Raw text body (use `json` for JSON). Not for GET."),
  timeout_s: z.number().int().min(1).max(MAX_TIMEOUT_MS / 1000).optional().describe("Seconds to wait (default 15, max 30)"),
});
type Input = z.infer<typeof inputSchema>;

/** What a stored approval holds: the request minus any secret (the connection is named by id and its key read at send time). */
interface StoredRequest extends HttpRequestSpec {
  connection_id?: string;
}

function toSpec(i: Input): HttpRequestSpec {
  if (i.json !== undefined && i.body !== undefined) throw new ToolError("Give either `json` or `body`, not both.");
  const query: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(i.query ?? {})) {
    if (v === null || v === undefined) continue;
    query[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : JSON.stringify(v);
  }
  return {
    method: i.method,
    url: i.url,
    ...(i.connection ? { connection: i.connection } : {}),
    ...(Object.keys(query).length ? { query } : {}),
    ...(i.headers ? { headers: i.headers } : {}),
    ...(i.json !== undefined ? { body: i.json } : i.body !== undefined ? { body: i.body } : {}),
    ...(i.timeout_s ? { timeout_ms: i.timeout_s * 1000 } : {}),
  };
}

function connectionFor(ref: string | undefined, ctx: ToolContext): ApiConnection | null {
  if (!ref) return null;
  const store = ctx.services.apiConnections;
  const found = store.find(ref);
  if (found) return found;
  const names = store.list().map((c) => `“${c.name}”`);
  throw new ToolError(
    names.length
      ? `There is no API connection named “${ref}”. Saved connections: ${names.join(", ")}.`
      : `There is no API connection named “${ref}”, and none are saved. The owner adds one (with its key) in Settings → API connections; never ask for a key in the chat.`,
  );
}

const wrap = <T,>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpToolError) throw new ToolError(e.message);
    throw e;
  }
};

async function send(spec: HttpRequestSpec, connection: ApiConnection | null, ctx: ToolContext): Promise<HttpResult> {
  const built = wrap(() => buildRequest(spec, connection));
  const secret = connection ? await ctx.services.apiConnections.secret(connection.id) : null;
  try {
    const result = await sendRequest(built, connection, { secret });
    if (connection && !secret) result.note = [result.note, `The connection “${connection.name}” has no saved key, so none was sent.`].filter(Boolean).join(" ");
    ctx.services.activity.record("http.request", `${built.method} ${displayUrl(built.url)}${connection ? ` (${connection.name})` : ""} → ${result.status}`);
    return result;
  } catch (e) {
    if (e instanceof HttpToolError) {
      ctx.services.activity.record("http.request", `${built.method} ${displayUrl(built.url)} → ${e.message.slice(0, 120)}`);
      throw new ToolError(e.message);
    }
    throw e;
  }
}

/** The line on the Approve card: method, URL, connection, and the start of the body. */
export function approvalSummary(spec: HttpRequestSpec, connection: ApiConnection | null): string {
  const built = buildRequest(spec, connection);
  const body = built.body ? ` — body: ${built.body.replace(/\s+/g, " ").slice(0, 240)}${built.body.length > 240 ? "…" : ""}` : "";
  return `${built.method} ${displayUrl(built.url)}${connection ? ` (connection “${connection.name}”)` : ""}${body}`;
}

function labelFor(i: Input): string {
  let target = i.url;
  try {
    const u = new URL(i.url);
    target = `${u.host}${u.pathname}`;
  } catch {
    /* a path under a connection */
  }
  return `${i.method ?? "GET"} ${i.connection ? `${i.connection} ` : ""}${target}`.slice(0, 120);
}

export const httpTools = [
  defineTool({
    name: HTTP_TOOL,
    description:
      "Call a REST/HTTP API on the internet: GET to read, POST/PUT/PATCH/DELETE to change data. For APIs that need a key, name a saved API connection and give a path; the key is added for you and you never see it. Returns the status, a few useful headers and the body (JSON parsed, long bodies cut). Requests other than GET may wait for the owner's approval; scheduled automations can only GET. Only public internet hosts can be reached.",
    permission: "read",
    maxCallsPerTurn: 4,
    input: inputSchema,
    label: labelFor,
    approval: {
      prepare: (i: Input, ctx: ToolContext): PreparedAction | null => {
        if (i.method === "GET" || !ctx.services.apiConnections.config().confirmNonGet) return null;
        const spec = toSpec(i);
        const connection = connectionFor(spec.connection, ctx);
        const summary = wrap(() => approvalSummary(spec, connection));
        const { connection: _name, ...rest } = spec;
        const stored: StoredRequest = { ...rest, ...(connection ? { connection_id: connection.id } : {}) };
        return {
          targetId: JSON.stringify(stored),
          summary,
          note: "Nothing was sent yet. The owner now sees an Approve button for exactly this request; it is sent only after they approve, and the result reaches them as a notification. Briefly tell them what you are about to send. Do not call http_request again for the same request and do not claim it was sent.",
        };
      },
      commit: async (targetId: string, ctx: ToolContext) => {
        const stored = JSON.parse(targetId) as StoredRequest;
        const { connection_id, ...spec } = stored;
        const connection = connection_id ? ctx.services.apiConnections.get(connection_id) : null;
        if (connection_id && !connection) throw new ToolError("The API connection for this request was deleted, so it was not sent.");
        const result = await send(spec, connection, ctx);
        const excerpt = (typeof result.body === "string" ? result.body : JSON.stringify(result.body) ?? "").slice(0, 600);
        const summary = approvalSummary(spec, connection);
        ctx.services.notifications.create({ title: result.ok ? "Request sent" : `Request answered ${result.status}`, body: `${summary}\n\n${result.status} ${result.status_text}\n${excerpt}`, kind: "result" });
        if (!result.ok) throw new ToolError(`Sent; the server answered ${result.status} ${result.status_text}`.trim() + (excerpt ? `: ${excerpt.slice(0, 200)}` : "."));
        return undefined;
      },
    },
    execute: async (i: Input, ctx: ToolContext) => {
      const method = i.method as HttpMethod;
      if (ctx.mode === "scheduled" && method !== "GET") {
        throw new ToolError("Scheduled automations can only make GET requests. Tell the owner the change needs to be done from a chat, where they can approve it.");
      }
      const spec = toSpec(i);
      return send(spec, connectionFor(spec.connection, ctx), ctx);
    },
  }),
] as ToolDefinition[];
