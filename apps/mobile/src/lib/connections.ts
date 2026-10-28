import type { ConnectField } from "@talorys/shared";
import { ApiError, api } from "./api";

/** OpenConnector through the agent (docs/system/CONNECTIONS.md). */
export interface ConnectedService {
  service: string;
  account: string | null;
  auth_type: string | null;
  name: string | null;
}

export interface CatalogService {
  id: string;
  name: string;
  he?: string;
  logo?: string | null;
}

export interface ConnectPlan {
  service: string;
  name: string;
  logo: string | null;
  method: "oauth" | "api_key" | "custom_credential";
  oauth_ready?: boolean;
  fields: ConnectField[];
}

export async function loadConnections(): Promise<{ configured: boolean; connections: ConnectedService[]; error?: string }> {
  try {
    return await api("/connections");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { configured: false, connections: [] };
    throw e;
  }
}

export async function loadCatalog(): Promise<{ configured: boolean; services: CatalogService[] }> {
  try {
    return await api("/connections/catalog");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { configured: false, services: [] };
    throw e;
  }
}

export const connectionPlan = (service: string) => api<ConnectPlan>(`/connections/${service}/plan`);

export const connectService = (service: string, values?: Record<string, string>) =>
  api<{ method: string; authorization_url?: string; connected?: boolean; account?: string | null }>(`/connections/${service}/connect`, { method: "POST", body: values ? { values } : {} });

export const connectionStatus = (service: string) => api<{ connected: boolean; account: string | null }>(`/connections/${service}`);

export const disconnect = (service: string) => api(`/connections/${service}`, { method: "DELETE" });

/** Catalog rows filtered by a query over the id, English and Hebrew names; connected ones left out. */
export function filterCatalog(services: CatalogService[], connected: Set<string>, query: string): CatalogService[] {
  const q = query.trim().toLowerCase();
  return services.filter((s) => !connected.has(s.id) && (!q || s.id.includes(q) || s.name.toLowerCase().includes(q) || (s.he ?? "").includes(query.trim())));
}
