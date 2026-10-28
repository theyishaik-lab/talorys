import { AI_PROVIDERS, type AiProviderId, aiEndpointUpdateSchema, type ChainRef, chainFromSettings, ENDPOINT_ID, isModelIdFor, type ModelCatalog, providerKeySchema, splitEndpointModel } from "@talorys/shared";
import { chainStatus, needsKey, type OpenRouterAllowance } from "../../ai/chain-status";
import { Hono } from "hono";
import { listGeminiModels } from "../../ai/gemini";
import type { KeyProvider } from "../../ai/keys";
import { checkOpenRouterKey } from "../../ai/openrouter";
import { ENDPOINT_PRESETS, endpointKeyName } from "../../ai/openai-compatible";
import { PROVIDER_NAMES } from "../../ai/provider";
import { openConnectorAdmin, openConnectorClient } from "../../openconnector";
import { KNOWN_SERVICES, serviceDisplayName, serviceLogo } from "../../openconnector/services";
import { planConnection } from "../../openconnector/connect";
import { ToolError } from "../../tools";
import { z } from "zod";
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

/**
 * OpenAI-compatible endpoints (OVH, Groq, …): each one's name, base URL and whether a key is stored
 * (only its hint). Its models are used as provider "openai-compatible", model "<id>/<model>".
 */
function endpointView(c: { env: AppEnv["Bindings"] }, e: { id: string; name: string; baseURL: string }) {
  return { ...e, key: c.env.agent.services.providerKeys.infoOf(endpointKeyName(e.id)) };
}

aiRoutes.get("/ai/endpoints", (c) => {
  const s = c.env.agent.services;
  return c.json({ endpoints: s.endpoints.list().map((e) => endpointView(c, e)), presets: ENDPOINT_PRESETS });
});

/** Adds or changes an endpoint (a preset id needs nothing else); `key` stores its API key encrypted, `key: null` removes it. */
aiRoutes.put("/ai/endpoints/:id", async (c) => {
  const s = c.env.agent.services;
  const id = c.req.param("id");
  if (!ENDPOINT_ID.test(id)) throw new AppError("VALIDATION_ERROR", "An endpoint id is lower-case letters, digits and dashes (up to 32).");
  const patch = await body(c, aiEndpointUpdateSchema);
  const endpoint = s.endpoints.upsert(id, { name: patch.name, baseURL: patch.baseURL });
  if (patch.key) {
    if (!s.providerKeys.available) throw new AppError("NOT_CONFIGURED", "The Worker has no SESSION_SECRET, so keys cannot be stored encrypted.");
    await s.providerKeys.set(endpointKeyName(id), patch.key);
  } else if (patch.key === null) {
    s.providerKeys.delete(endpointKeyName(id));
  }
  s.cooldowns.clear("openai-compatible");
  s.activity.record("ai.endpoint_set", `${endpoint.name} (${endpoint.baseURL})${patch.key ? " with a key" : ""}`);
  return c.json({ endpoint: endpointView(c, endpoint) });
});

aiRoutes.delete("/ai/endpoints/:id", (c) => {
  const s = c.env.agent.services;
  const id = c.req.param("id");
  if (!s.endpoints.delete(id)) throw new NotFoundError("Unknown endpoint.");
  s.providerKeys.delete(endpointKeyName(id));
  s.activity.record("ai.endpoint_removed", id);
  return c.json({ ok: true });
});

/**
 * Settings → Model: every model in the chain, in order, with its state (available / paused /
 * daily quota used up / not set up) and what is left where the provider tells — OpenRouter's key
 * API (asked now, costs nothing) and the rate-limit headers of the last response (Groq, OVH, …).
 * Read-only; editing the chain is `PATCH /api/settings`.
 */
aiRoutes.get("/ai/chain", async (c) => {
  const s = c.env.agent.services;
  const settings = s.settings.get();
  const list = chainFromSettings(settings);
  let openRouter: OpenRouterAllowance | null = null;
  if (list.some((r) => r.provider === "openrouter")) {
    const key = await s.providerKeys.get("openrouter");
    if (key) {
      try {
        openRouter = (await checkOpenRouterKey(key, AbortSignal.timeout(5_000))).free_daily;
      } catch {
        openRouter = null; // unknown; the screen says so
      }
    }
  }
  const configured = (ref: ChainRef) => {
    if (needsKey(ref.provider)) return s.providerKeys.has(ref.provider);
    if (ref.provider === "openai-compatible") {
      const id = splitEndpointModel(ref.model)?.endpoint;
      return !!id && !!s.endpoints.get(id);
    }
    return !!c.env.env.AI;
  };
  const status = chainStatus(settings, {
    cooldowns: s.cooldowns,
    quotas: s.quotas,
    configured,
    endpointName: (id) => s.endpoints.get(id)?.name ?? null,
    openRouter,
    now: Date.now(),
  });
  return c.json(status);
});

/** The models an OpenAI-compatible endpoint offers (its own `GET /models`), for "add to chain". */
aiRoutes.get("/ai/endpoints/:id/models", async (c) => {
  const s = c.env.agent.services;
  const endpoint = s.endpoints.get(c.req.param("id"));
  if (!endpoint) throw new NotFoundError("Unknown endpoint.");
  const key = await s.providerKeys.get(endpointKeyName(endpoint.id));
  try {
    const r = await fetch(`${endpoint.baseURL}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(8_000) });
    if (!r.ok) return c.json({ models: [], error: `${endpoint.name} answered ${r.status}` });
    const body = (await r.json()) as { data?: { id?: unknown }[] };
    const models = (body.data ?? [])
      .map((m) => (typeof m.id === "string" ? m.id : null))
      .filter((id): id is string => !!id && isModelIdFor("openai-compatible", `${endpoint.id}/${id}`))
      // Speech, TTS, guard and embedding models cannot chat.
      .filter((id) => !/whisper|tts|orpheus|guard|embed|rerank|moderation/i.test(id))
      .sort();
    return c.json({ models, error: null });
  } catch (error) {
    return c.json({ models: [], error: error instanceof Error ? error.message.slice(0, 160) : String(error) });
  }
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
  if (raw === "openai-compatible") throw new AppError("VALIDATION_ERROR", "An endpoint's key is set with PUT /api/ai/endpoints/:id.");
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

/** The catalog of known services, for the Connections page. */
aiRoutes.get("/connections/catalog", (c) => {
  return c.json({
    services: KNOWN_SERVICES.map((s) => ({ id: s.id, name: s.name, he: s.he, logo: serviceLogo(s.id) })),
    configured: !!openConnectorClient(c.env.env),
  });
});

/** Disconnect a service by removing its credential from the connector. */
aiRoutes.delete("/connections/:service", async (c) => {
  const admin = openConnectorAdmin(c.env.env);
  if (!admin) throw new AppError("CONFLICT", "OpenConnector admin is not configured.");
  const service = c.req.param("service");
  if (!/^[a-z0-9_]{2,60}$/i.test(service)) throw new NotFoundError("Unknown service.");
  await admin.deleteConnection(service);
  return c.json({ deleted: true });
});

const SERVICE_ID = /^[a-z0-9_]{2,60}$/i;

/** How a service can be connected from the app: OAuth (a browser sign-in) or the fields to type. */
aiRoutes.get("/connections/:service/plan", async (c) => {
  const service = c.req.param("service");
  if (!SERVICE_ID.test(service)) throw new NotFoundError("Unknown service.");
  const admin = openConnectorAdmin(c.env.env);
  if (!admin) throw new AppError("NOT_CONFIGURED", "OpenConnector admin is not configured.");
  try {
    const provider = await admin.provider(service);
    if (!provider) throw new NotFoundError("Unknown service.");
    const plan = await planConnection(admin, provider);
    return c.json({
      service,
      name: provider.displayName ?? serviceDisplayName(service),
      logo: serviceLogo(service),
      method: plan.method,
      oauth_ready: plan.method === "oauth" ? !!plan.oauthReady : undefined,
      fields: plan.fields ?? [],
    });
  } catch (error) {
    if (error instanceof ToolError) throw new AppError("CONFLICT", error.message);
    throw error;
  }
});

/**
 * Connects a service straight from the app's Connections screen. The owner is signed in and tapped
 * Connect themselves, so this is the approval (the chat's connect card needs one because the model
 * proposes it). OAuth → a fresh consent link the app opens in the browser; key-based → the typed
 * values go to OpenConnector, which validates them. Values are never stored, logged or echoed here.
 */
const connectSchema = z.object({ values: z.record(z.string().max(100), z.string().max(4096)).optional() });
aiRoutes.post("/connections/:service/connect", async (c) => {
  const service = c.req.param("service");
  if (!SERVICE_ID.test(service)) throw new NotFoundError("Unknown service.");
  const admin = openConnectorAdmin(c.env.env);
  if (!admin) throw new AppError("NOT_CONFIGURED", "OpenConnector admin is not configured.");
  const { values } = await body(c, connectSchema, 32 * 1024);
  const s = c.env.agent.services;
  try {
    const provider = await admin.provider(service);
    if (!provider) throw new NotFoundError("Unknown service.");
    const name = provider.displayName ?? serviceDisplayName(service);
    const plan = await planConnection(admin, provider);
    if (plan.method === "oauth") {
      if (!plan.oauthReady) throw new AppError("CONFLICT", `${name} needs a one-time setup in the OpenConnector console (its OAuth app) before it can be connected.`);
      const url = await admin.startOAuth(service);
      s.activity.record("connections.oauth_started", `Sign-in started for ${name}`);
      return c.json({ method: "oauth", authorization_url: url });
    }
    const fields = plan.fields ?? [];
    const submitted: Record<string, string> = {};
    for (const f of fields) {
      const v = values?.[f.key]?.trim();
      if (v) submitted[f.key] = v;
      else if (f.required !== false) throw new AppError("VALIDATION_ERROR", `${f.label} is required.`);
    }
    const profile = await admin.storeCredential(service, plan.method, submitted);
    s.activity.record("connections.connected", `Connected ${name}`);
    return c.json({ method: plan.method, connected: true, account: profile.profile?.displayName ?? profile.profile?.accountId ?? null });
  } catch (error) {
    if (error instanceof ToolError) throw new AppError("VALIDATION_ERROR", error.message);
    throw error;
  }
});
