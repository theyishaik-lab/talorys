import { AI_PROVIDERS, type AiProviderId, type ModelCatalog, providerKeySchema } from "@talorys/shared";
import { Hono } from "hono";
import { listGeminiModels } from "../../ai/gemini";
import type { KeyProvider } from "../../ai/keys";
import { checkOpenRouterKey } from "../../ai/openrouter";
import { PROVIDER_NAMES } from "../../ai/provider";
import { openConnectorClient } from "../../openconnector";
import type { AppEnv } from "../app";
import { AppError, NotFoundError } from "../errors";
import { body } from "../middleware";

/**
 * Settings → Model: the model lists per provider, and the API keys of the providers that need
 * one. A key is validated against the provider's model list (no generation, no quota spent),
 * stored encrypted, and only its last four characters ever come back.
 */
export const aiRoutes = new Hono<AppEnv>();

aiRoutes.get("/ai/models", async (c) => {
  const s = c.env.agent.services;
  const settings = s.settings.get();
  const refresh = c.req.query("refresh") === "1";
  const catalog: ModelCatalog = await s.catalog.catalog({ provider: settings.modelProvider, model: settings.model }, { refresh });
  return c.json({ ...catalog, keys_available: s.providerKeys.available, fallback: settings.fallback, cooldowns: s.cooldowns.list() });
});

/** Models paused after a quota / overload failure, and when each comes back. */
aiRoutes.get("/ai/cooldowns", (c) => c.json({ cooldowns: c.env.agent.services.cooldowns.list() }));

/** Ends every pause now (the next turn tries each model again). */
aiRoutes.delete("/ai/cooldowns", (c) => {
  const s = c.env.agent.services;
  s.cooldowns.clear();
  s.activity.record("ai.cooldown", "All model pauses cleared");
  return c.json({ cooldowns: [] });
});

function keyProvider(raw: string): KeyProvider {
  if (raw === "gemini" || raw === "openrouter") return raw;
  if ((AI_PROVIDERS as readonly string[]).includes(raw)) throw new AppError("VALIDATION_ERROR", `${PROVIDER_NAMES[raw as AiProviderId]} needs no API key.`);
  throw new NotFoundError("Unknown provider.");
}

/** Checks a key with the provider (model list / key info: free calls). Throws a NOT_CONFIGURED error with the provider's words. */
async function verifyKey(provider: KeyProvider, key: string): Promise<{ models: number; note: string | null }> {
  const signal = AbortSignal.timeout(10_000);
  try {
    if (provider === "gemini") {
      const models = await listGeminiModels(key, signal);
      return { models: models.length, note: null };
    }
    const info = await checkOpenRouterKey(key, signal);
    return { models: 0, note: info.label ? `Key "${info.label}"` : null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError("NOT_CONFIGURED", `${PROVIDER_NAMES[provider]} did not accept this key: ${message.slice(0, 160)}`, { provider });
  }
}

aiRoutes.get("/ai/keys", (c) => c.json({ keys: c.env.agent.services.providerKeys.info(), available: c.env.agent.services.providerKeys.available }));

/** Stores a key after the provider accepted it. The response never contains the key. */
aiRoutes.put("/ai/keys/:provider", async (c) => {
  const s = c.env.agent.services;
  const provider = keyProvider(c.req.param("provider"));
  if (!s.providerKeys.available) throw new AppError("NOT_CONFIGURED", "The Worker has no SESSION_SECRET, so keys cannot be stored encrypted.");
  const { key } = await body(c, providerKeySchema);
  const check = await verifyKey(provider, key.trim());
  const info = await s.providerKeys.set(provider, key.trim());
  s.catalog.invalidate(provider);
  // A new key may lift a quota or a "key rejected" pause.
  s.cooldowns.clear(provider);
  s.activity.record("ai.key_set", `${PROVIDER_NAMES[provider]} API key saved (${info.hint})`);
  return c.json({ key: info, check });
});

aiRoutes.delete("/ai/keys/:provider", (c) => {
  const s = c.env.agent.services;
  const provider = keyProvider(c.req.param("provider"));
  s.providerKeys.delete(provider);
  s.catalog.invalidate(provider);
  s.activity.record("ai.key_removed", `${PROVIDER_NAMES[provider]} API key removed`);
  return c.body(null, 204);
});

/** Re-checks the stored key with the provider. Costs no generation quota. */
aiRoutes.post("/ai/keys/:provider/test", async (c) => {
  const s = c.env.agent.services;
  const provider = keyProvider(c.req.param("provider"));
  const key = await s.providerKeys.get(provider);
  if (!key) throw new NotFoundError(`No ${PROVIDER_NAMES[provider]} key is stored.`);
  const check = await verifyKey(provider, key);
  return c.json({ ok: true, ...check });
});

interface ConnectionRow {
  service?: string;
  authType?: string;
  connectionName?: string;
  profile?: { displayName?: string; accountId?: string };
}

/** The services connected through OpenConnector (with an account), for Settings → Connections. */
aiRoutes.get("/connections", async (c) => {
  const client = openConnectorClient(c.env.env);
  if (!client) return c.json({ configured: false, connections: [] });
  try {
    const rows = (await client.data("list_connections", {})) as unknown;
    const list = Array.isArray(rows) ? (rows as ConnectionRow[]) : [];
    const connections = list
      .filter((r) => typeof r.service === "string" && r.authType && r.authType !== "no_auth")
      .map((r) => ({ service: r.service as string, account: r.profile?.displayName ?? r.profile?.accountId ?? null, auth_type: r.authType ?? null, name: r.connectionName ?? null }));
    return c.json({ configured: true, connections });
  } catch (error) {
    return c.json({ configured: true, connections: [], error: error instanceof Error ? error.message.slice(0, 200) : String(error) });
  }
});
