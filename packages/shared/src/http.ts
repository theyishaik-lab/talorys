import { z } from "zod";

/**
 * Saved API connections for the agent's `http_request` tool (docs/http-requests.md). A connection
 * is a name, a base URL and an optional auth header; the header's VALUE (the secret) is stored
 * encrypted apart from this record and only its last four characters ever reach a client.
 */
export const API_CONNECTION_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Header names a connection may not use for its secret (they belong to the transport). */
const RESERVED_AUTH_HEADERS = new Set(["host", "content-length", "content-type", "connection", "transfer-encoding", "cookie"]);

export const apiConnectionSchema = z.object({
  name: z.string().trim().min(1).max(60),
  baseURL: z
    .string()
    .trim()
    .url()
    .max(300)
    .refine((v) => v.startsWith("https://"), "A connection's base URL must be https, so its key never travels in the clear"),
  /** The header the secret is sent in, e.g. `Authorization` or `X-API-Key`. */
  authHeader: z
    .string()
    .trim()
    .max(60)
    .regex(/^[A-Za-z0-9-]+$/, "A header name is letters, digits and dashes")
    .refine((v) => !RESERVED_AUTH_HEADERS.has(v.toLowerCase()), "That header cannot carry a key")
    .default("Authorization"),
});
export type ApiConnectionInput = z.infer<typeof apiConnectionSchema>;

/** PUT /api/http/connections/:id. `secret: null` removes a stored secret; omitted keeps it. */
export const apiConnectionUpdateSchema = z.object({
  name: apiConnectionSchema.shape.name.optional(),
  baseURL: apiConnectionSchema.shape.baseURL.optional(),
  authHeader: z.union([apiConnectionSchema.shape.authHeader, z.literal("")]).optional(),
  secret: z.string().trim().min(1).max(4096).nullable().optional(),
});
export type ApiConnectionUpdate = z.infer<typeof apiConnectionUpdateSchema>;

/** PUT /api/http/settings */
export const httpSettingsSchema = z.object({
  /** Requests other than GET wait for the owner's Approve on a card (default on). */
  confirmNonGet: z.boolean(),
});
export type HttpSettings = z.infer<typeof httpSettingsSchema>;

/** What a client sees of a connection: never the secret, only its hint (`…k2Q9`). */
export interface ApiConnectionView {
  id: string;
  name: string;
  baseURL: string;
  authHeader: string;
  secret: { set: boolean; hint: string | null; added_at: string | null };
}

export interface ApiConnectionsResponse {
  connections: ApiConnectionView[];
  settings: HttpSettings;
  /** False when the Worker has no SESSION_SECRET, so secrets cannot be stored. */
  secrets_available: boolean;
}

/** A connection id from its display name ("Weather API" → "weather-api"); empty when nothing usable is left. */
export function apiConnectionIdFromName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}
