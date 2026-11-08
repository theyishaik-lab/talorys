import type { ApiConnectionView, ApiConnectionsResponse, HttpSettings } from "@talorys/shared";
import { api } from "./api";

/** Settings → API connections (the agent's http_request tool). The key goes to the agent once; only its hint comes back. */
export type { ApiConnectionView };

export function loadApiConnections(): Promise<ApiConnectionsResponse> {
  return api<ApiConnectionsResponse>("/http/connections");
}

export interface ApiConnectionDraft {
  name: string;
  baseURL: string;
  authHeader: string;
  /** A new key; empty keeps the saved one; null removes it. */
  secret: string | null;
}

/** The request body for a save: an empty key field means "keep" (omitted), null means "remove". */
export function connectionBody(d: ApiConnectionDraft, existing: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { name: d.name.trim(), baseURL: d.baseURL.trim(), authHeader: d.authHeader.trim() || "Authorization" };
  if (d.secret === null) {
    if (existing) body.secret = null;
  } else if (d.secret.trim()) body.secret = d.secret.trim();
  return body;
}

export function isDraftReady(d: Pick<ApiConnectionDraft, "name" | "baseURL" | "authHeader">): boolean {
  return d.name.trim().length > 0 && /^https:\/\/[^/\s]+\.[^\s]+/.test(d.baseURL.trim()) && /^[A-Za-z0-9-]*$/.test(d.authHeader.trim());
}

export async function saveApiConnection(id: string | null, d: ApiConnectionDraft): Promise<ApiConnectionView> {
  const body = connectionBody(d, id !== null);
  const r = id ? await api<{ connection: ApiConnectionView }>(`/http/connections/${id}`, { method: "PUT", body }) : await api<{ connection: ApiConnectionView }>("/http/connections", { method: "POST", body });
  return r.connection;
}

export async function deleteApiConnection(id: string): Promise<void> {
  await api(`/http/connections/${id}`, { method: "DELETE" });
}

export async function setHttpSettings(patch: Partial<HttpSettings>): Promise<HttpSettings> {
  return (await api<{ settings: HttpSettings }>("/http/settings", { method: "PUT", body: patch })).settings;
}
