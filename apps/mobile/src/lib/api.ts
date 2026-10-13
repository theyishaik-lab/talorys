import { fetch as streamingFetch } from "expo/fetch";
import type { ApiErrorBody, ApiErrorCode, ChatStreamEvent } from "@talorys/shared";
import { getServerUrl, getToken, notifyUnauthorized } from "./session";

/** Same header the web app sends; the agent rejects state changes without it. */
export const CSRF_HEADER = "x-talorys-request";
/** Tells the agent this is the native app, so /auth/login returns the session token in the body. */
export const CLIENT_HEADER = "x-talorys-client";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | "NETWORK",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    /* non-JSON error */
  }
  const code = body.error?.code ?? (res.status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR");
  const message = body.error?.message ?? (res.status >= 500 ? "Talorys is temporarily unavailable." : `Request failed (${res.status})`);
  return new ApiError(res.status, code, message, body.error?.details);
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const token = getToken();
  return {
    [CSRF_HEADER]: "1",
    [CLIENT_HEADER]: "native",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export function apiUrl(path: string, server = getServerUrl()): string {
  return `${server.replace(/\/+$/, "")}/api${path}`;
}

/** JSON API call to the person's own agent. The bearer token is this phone's session. */
export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal; server?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(path, init.server), {
      method: init.method ?? "GET",
      headers: headers(init.body !== undefined ? { "content-type": "application/json" } : {}),
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });
  } catch (error) {
    throw new ApiError(0, "NETWORK", error instanceof Error ? error.message : "Network error");
  }
  if (!res.ok) {
    const error = await toApiError(res);
    if (res.status === 401 && !path.startsWith("/auth/")) notifyUnauthorized();
    throw error;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Splits an SSE byte stream into parsed `data:` frames; shared by the live client and the tests. */
export function createSseParser(onEvent: (event: ChatStreamEvent) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as ChatStreamEvent);
      } catch {
        /* ignore malformed frame */
      }
    }
  };
}

/**
 * POSTs a chat message and consumes the agent's Server-Sent Events incrementally.
 * Uses Expo's streaming fetch (React Native's own fetch buffers the whole body).
 */
export async function streamChat(
  payload: { conversation_id?: string; message: string; retry?: boolean },
  onEvent: (event: ChatStreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Awaited<ReturnType<typeof streamingFetch>>;
  try {
    res = await streamingFetch(apiUrl("/chat"), {
      method: "POST",
      headers: headers({ "content-type": "application/json", accept: "text/event-stream" }),
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    throw new ApiError(0, "NETWORK", error instanceof Error ? error.message : "Network error");
  }
  if (!res.ok || !res.body) {
    const error = await toApiError(res as unknown as Response);
    if (res.status === 401) notifyUnauthorized();
    throw error;
  }
  const decoder = new TextDecoder();
  const parse = createSseParser(onEvent);
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) parse(decoder.decode(value, { stream: true }));
  }
}
