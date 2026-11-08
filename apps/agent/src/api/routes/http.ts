import { type ApiConnectionsResponse, API_CONNECTION_ID, apiConnectionSchema, apiConnectionUpdateSchema, httpSettingsSchema } from "@talorys/shared";
import { Hono } from "hono";
import type { AppEnv } from "../app";
import { AppError, NotFoundError } from "../errors";
import { body } from "../middleware";

/**
 * Settings → API connections, for the agent's `http_request` tool. A connection's secret is
 * stored encrypted (same store as the provider keys) and only its hint ever comes back.
 */
export const httpRoutes = new Hono<AppEnv>();

const NO_SECRET_STORE = "The Worker has no SESSION_SECRET, so keys cannot be stored encrypted.";

httpRoutes.get("/http/connections", (c) => {
  const s = c.env.agent.services;
  const store = s.apiConnections;
  const out: ApiConnectionsResponse = { connections: store.list().map((x) => store.view(x)), settings: store.config(), secrets_available: s.providerKeys.available };
  return c.json(out);
});

/** Adds a connection; the id is made from the name. */
httpRoutes.post("/http/connections", async (c) => {
  const s = c.env.agent.services;
  const input = await body(c, apiConnectionUpdateSchema.extend({ name: apiConnectionSchema.shape.name, baseURL: apiConnectionSchema.shape.baseURL }));
  if (input.secret && !s.providerKeys.available) throw new AppError("NOT_CONFIGURED", NO_SECRET_STORE);
  const store = s.apiConnections;
  const conn = store.upsert(store.newId(input.name), { name: input.name, baseURL: input.baseURL, ...(input.authHeader ? { authHeader: input.authHeader } : {}) });
  if (input.secret) await store.setSecret(conn.id, input.secret);
  s.activity.record("http.connection_added", `${conn.name} (${conn.baseURL})${input.secret ? " with a key" : ""}`);
  return c.json({ connection: store.view(conn) }, 201);
});

/** Changes a connection; `secret` replaces the stored key, `secret: null` removes it, omitted keeps it. */
httpRoutes.put("/http/connections/:id", async (c) => {
  const s = c.env.agent.services;
  const id = c.req.param("id");
  const store = s.apiConnections;
  if (!API_CONNECTION_ID.test(id) || !store.get(id)) throw new NotFoundError("Unknown connection.");
  const patch = await body(c, apiConnectionUpdateSchema);
  if (patch.secret && !s.providerKeys.available) throw new AppError("NOT_CONFIGURED", NO_SECRET_STORE);
  const before = store.get(id)!;
  const conn = store.upsert(id, { name: patch.name, baseURL: patch.baseURL, ...(patch.authHeader ? { authHeader: patch.authHeader } : {}) });
  // A key belongs to the host it was given for: moving the base URL to another origin drops it unless a new one comes with the change.
  const movedOrigin = new URL(before.baseURL).origin !== new URL(conn.baseURL).origin;
  if (patch.secret !== undefined) await store.setSecret(id, patch.secret);
  else if (movedOrigin) await store.setSecret(id, null);
  s.activity.record("http.connection_set", `${conn.name} (${conn.baseURL})${patch.secret ? " with a new key" : patch.secret === null || movedOrigin ? " key removed" : ""}`);
  return c.json({ connection: store.view(conn) });
});

httpRoutes.delete("/http/connections/:id", (c) => {
  const s = c.env.agent.services;
  const id = c.req.param("id");
  if (!s.apiConnections.delete(id)) throw new NotFoundError("Unknown connection.");
  s.activity.record("http.connection_removed", id);
  return c.json({ ok: true });
});

httpRoutes.put("/http/settings", async (c) => {
  const s = c.env.agent.services;
  const patch = await body(c, httpSettingsSchema.partial());
  const settings = s.apiConnections.setConfig(patch);
  s.activity.record("http.settings", `confirm non-GET: ${settings.confirmNonGet ? "on" : "off"}`);
  return c.json({ settings });
});
