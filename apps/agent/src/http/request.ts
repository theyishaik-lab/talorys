import { BlockedHostError, assertPublicDestination, dohResolver, type Resolver } from "./ssrf";
import type { ApiConnection } from "./connections";

/**
 * Building and sending one HTTP request for the agent's `http_request` tool. Runs inside the agent
 * Durable Object (a Worker), so there is no CORS and the web app and the Android app get the same
 * behaviour. Every hop (redirects included) passes the SSRF guard; the response is read up to a
 * byte cap and shortened again for the model; a connection's secret is added only here, at send
 * time, and scrubbed from anything the server echoes back.
 */

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export const DEFAULT_TIMEOUT_MS = 15_000;
export const MAX_TIMEOUT_MS = 30_000;
/** Bytes read from the network at most; the rest of a bigger response is never downloaded. */
export const MAX_RESPONSE_BYTES = 512 * 1024;
/** Characters of the body the model sees at most. */
export const MODEL_BODY_CHARS = 8_000;
export const MAX_REDIRECTS = 3;
export const MAX_REQUEST_BODY_CHARS = 64 * 1024;

/** Response headers worth showing the model; everything else (cookies included) is left out. */
const KEPT_RESPONSE_HEADERS = ["content-type", "content-length", "location", "retry-after", "etag", "last-modified", "date", "cache-control", "www-authenticate"];
const KEPT_PREFIXES = ["x-ratelimit-", "ratelimit-", "x-rate-limit-"];

/** Request headers the model may not set: the transport's own, and cookies. */
const FORBIDDEN_REQUEST_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "cookie", "proxy-authorization", "cf-connecting-ip", "x-forwarded-for", "x-real-ip"]);

export interface HttpRequestSpec {
  method: HttpMethod;
  /** An absolute URL, or — with a connection — a path under its base URL. */
  url: string;
  connection?: string;
  headers?: Record<string, string>;
  query?: Record<string, string | number | boolean>;
  /** A JSON value (sent as application/json) or a string (sent as text/plain unless a content-type header says otherwise). */
  body?: unknown;
  timeout_ms?: number;
}

export class HttpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpToolError";
  }
}

export interface BuiltRequest {
  url: URL;
  method: HttpMethod;
  headers: Headers;
  body: string | undefined;
  timeoutMs: number;
}

/**
 * The request exactly as it will be sent, minus the secret: URL (connection base + path + query),
 * headers (forbidden ones refused, the connection's auth header reserved for its secret), body.
 */
export function buildRequest(spec: HttpRequestSpec, connection: ApiConnection | null): BuiltRequest {
  let url: URL;
  const raw = spec.url.trim();
  if (connection) {
    const base = new URL(`${connection.baseURL}/`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) {
      try {
        url = new URL(raw);
      } catch {
        throw new HttpToolError(`"${raw}" is not a valid URL.`);
      }
      if (url.origin !== base.origin || !url.pathname.startsWith(new URL(connection.baseURL).pathname.replace(/\/?$/, ""))) {
        throw new HttpToolError(`With the connection “${connection.name}”, give a path under ${connection.baseURL} (its key is only sent there).`);
      }
    } else {
      const path = raw.replace(/^\/+/, "");
      url = new URL(path, base);
      if (url.origin !== base.origin || !url.href.startsWith(base.href.replace(/\/$/, ""))) {
        throw new HttpToolError(`The path must stay under ${connection.baseURL}.`);
      }
    }
  } else {
    try {
      url = new URL(raw);
    } catch {
      throw new HttpToolError(`"${raw}" is not an absolute URL. Give the full https:// address, or name a saved API connection and a path.`);
    }
  }
  url.hash = "";
  for (const [k, v] of Object.entries(spec.query ?? {})) url.searchParams.append(k, String(v));

  const headers = new Headers();
  const authHeader = connection?.authHeader.toLowerCase();
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    const lower = name.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(lower)) throw new HttpToolError(`"${name}" is not a valid header name.`);
    if (FORBIDDEN_REQUEST_HEADERS.has(lower)) throw new HttpToolError(`The "${name}" header cannot be set.`);
    if (authHeader && lower === authHeader) throw new HttpToolError(`The "${name}" header is set by the connection “${connection!.name}” from its saved key; leave it out.`);
    headers.set(lower, String(value));
  }
  if (!headers.has("accept")) headers.set("accept", "application/json, text/plain;q=0.9, */*;q=0.5");
  if (!headers.has("user-agent")) headers.set("user-agent", "Talorys-Agent/1 (+https://github.com/theyishaik-lab/talorys)");

  let body: string | undefined;
  if (spec.body !== undefined && spec.body !== null) {
    if (spec.method === "GET") throw new HttpToolError("A GET request has no body; put the values in query instead.");
    if (typeof spec.body === "string") {
      body = spec.body;
      if (!headers.has("content-type")) headers.set("content-type", "text/plain; charset=utf-8");
    } else {
      body = JSON.stringify(spec.body);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
    }
    if (body.length > MAX_REQUEST_BODY_CHARS) throw new HttpToolError(`The body is ${body.length} characters; the limit is ${MAX_REQUEST_BODY_CHARS}.`);
  }
  const timeoutMs = Math.min(Math.max(spec.timeout_ms ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);
  return { url, method: spec.method, headers, body, timeoutMs };
}

/** The URL with every query value of a secret-looking parameter masked, for summaries and results. */
export function displayUrl(url: URL): string {
  const u = new URL(url.href);
  for (const key of [...u.searchParams.keys()]) {
    if (/(key|token|secret|password|auth|signature|sig)/i.test(key)) u.searchParams.set(key, "•••");
  }
  return u.href;
}

export interface HttpResult {
  status: number;
  status_text: string;
  ok: boolean;
  method: HttpMethod;
  url: string;
  connection?: string;
  redirected_to?: string;
  headers: Record<string, string>;
  /** Parsed JSON when the response is JSON and fits; otherwise text. */
  body: unknown;
  body_bytes: number;
  truncated: boolean;
  note?: string;
}

export interface SendOptions {
  secret?: string | null;
  resolve?: Resolver;
  fetcher?: typeof fetch;
  modelChars?: number;
}

/** Replaces every occurrence of the secret (and its Bearer form) so an echoing server cannot hand it to the model. */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 4) return text;
  let out = text.split(secret).join("[secret hidden]");
  // "Bearer abc…": a server may echo only the token part.
  const token = /^[A-Za-z][\w-]*\s+(\S{8,})$/.exec(secret.trim())?.[1];
  if (token) out = out.split(token).join("[secret hidden]");
  return out;
}

/** Reads a body up to `max` bytes; reports whether more was there. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > max) {
      chunks.push(value.subarray(0, max - size));
      size = max;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return { bytes: out, truncated };
}

function keptHeaders(h: Headers, secret: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (KEPT_RESPONSE_HEADERS.includes(lower) || KEPT_PREFIXES.some((p) => lower.startsWith(p))) out[lower] = redactSecret(value, secret).slice(0, 300);
  });
  return out;
}

const isTextual = (type: string) => !type || /^text\/|json|xml|javascript|x-www-form-urlencoded|csv|yaml|graphql/i.test(type);

/**
 * Sends the built request: SSRF check on every hop, the secret added under the connection's
 * header, redirects followed by hand (at most MAX_REDIRECTS, each re-checked; the secret is only
 * sent to the connection's own origin; a 303, or a 301/302 after POST, becomes a bodiless GET).
 */
export async function sendRequest(req: BuiltRequest, connection: ApiConnection | null, opts: SendOptions = {}): Promise<HttpResult> {
  const resolve = opts.resolve ?? dohResolver;
  const fetcher = opts.fetcher ?? ((i, init) => fetch(i, init));
  const secret = opts.secret ?? null;
  const signal = AbortSignal.timeout(req.timeoutMs);
  const secretOrigin = connection ? new URL(connection.baseURL).origin : null;
  let url = req.url;
  let method: HttpMethod = req.method;
  let body = req.body;
  let res: Response | null = null;
  for (let hop = 0; ; hop++) {
    try {
      await assertPublicDestination(url, resolve);
    } catch (e) {
      if (e instanceof BlockedHostError) throw new HttpToolError(`Blocked: ${e.message}`);
      throw e;
    }
    const headers = new Headers(req.headers);
    if (connection && secret && url.origin === secretOrigin) headers.set(connection.authHeader, secret);
    if (body === undefined) headers.delete("content-type");
    try {
      res = await fetcher(url.href, { method, headers, body, redirect: "manual", signal });
    } catch (e) {
      const name = (e as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") throw new HttpToolError(`No answer from ${url.host} within ${Math.round(req.timeoutMs / 1000)} s.`);
      throw new HttpToolError(`Could not reach ${url.host}: ${redactSecret(e instanceof Error ? e.message : String(e), secret)}`);
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
      if (hop >= MAX_REDIRECTS) throw new HttpToolError(`Too many redirects (more than ${MAX_REDIRECTS}).`);
      await res.body?.cancel().catch(() => {});
      url = new URL(location, url);
      url.hash = "";
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET")) {
        method = "GET";
        body = undefined;
      }
      continue;
    }
    break;
  }
  const type = res.headers.get("content-type") ?? "";
  const { bytes, truncated: cut } = await readCapped(res, MAX_RESPONSE_BYTES);
  const modelChars = opts.modelChars ?? MODEL_BODY_CHARS;
  const result: HttpResult = {
    status: res.status,
    status_text: res.statusText,
    ok: res.ok,
    method: req.method,
    url: displayUrl(req.url),
    ...(connection ? { connection: connection.name } : {}),
    ...(url.href !== req.url.href ? { redirected_to: displayUrl(url) } : {}),
    headers: keptHeaders(res.headers, secret),
    body: null,
    body_bytes: bytes.byteLength,
    truncated: cut,
  };
  if (!isTextual(type)) {
    result.body = null;
    result.note = `Binary response (${type}, ${bytes.byteLength}${cut ? "+" : ""} bytes) not shown.`;
    return result;
  }
  const text = redactSecret(new TextDecoder().decode(bytes), secret);
  if (!cut && /json/i.test(type) && text.length <= modelChars) {
    try {
      result.body = JSON.parse(text);
      return result;
    } catch {
      /* fall through to text */
    }
  }
  if (text.length > modelChars) {
    result.body = text.slice(0, modelChars);
    result.truncated = true;
    result.note = `Body cut to ${modelChars} of ${cut ? `more than ${text.length}` : text.length} characters. Ask the API for less (filters, fields, a smaller page) if the part you need is missing.`;
  } else {
    result.body = text;
    if (cut) result.note = `The response was larger than ${MAX_RESPONSE_BYTES} bytes; only the start was read.`;
  }
  return result;
}
