import { pushPrefsSchema, pushSubscribeSchema } from "@talorys/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { AppError, NotFoundError } from "../errors";
import { body } from "../middleware";

/**
 * Device notifications (Web Push). A browser subscribes with its own push-service endpoint and
 * keys; the Worker encrypts every message for that device and signs it with the install's VAPID
 * key. The endpoint and keys never leave the agent's database.
 */
export const pushRoutes = new Hono<AppEnv>();

/** Whether push is configured on this install, and the public key a browser subscribes with. */
pushRoutes.get("/push/config", (c) => {
  const push = c.env.agent.services.push;
  return c.json({ enabled: push.enabled, public_key: push.publicKey, subscriptions: push.list().length });
});

pushRoutes.get("/push/subscriptions", (c) => c.json({ subscriptions: c.env.agent.services.push.list() }));

/** Registers this browser (idempotent per endpoint) and returns its row. */
pushRoutes.post("/push/subscriptions", async (c) => {
  const push = c.env.agent.services.push;
  if (!push.enabled) throw new AppError("NOT_CONFIGURED", "Device notifications are not set up on this install (no VAPID keys).");
  const input = await body(c, pushSubscribeSchema);
  const subscription = push.subscribe({ endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, label: input.label, prefs: input.prefs });
  return c.json({ subscription }, 201);
});

/** The row behind an endpoint, so a browser can find its own device after a reload. */
pushRoutes.post("/push/subscriptions/lookup", async (c) => {
  const { endpoint } = await body(c, z.object({ endpoint: z.string().url().max(2048) }));
  const push = c.env.agent.services.push;
  const id = push.idForEndpoint(endpoint);
  return c.json({ subscription: id ? push.get(id) : null });
});

pushRoutes.patch("/push/subscriptions/:id", async (c) => {
  const patch = await body(c, pushPrefsSchema);
  const subscription = c.env.agent.services.push.setPrefs(c.req.param("id"), patch);
  if (!subscription) throw new NotFoundError("This device is no longer registered.");
  return c.json({ subscription });
});

pushRoutes.delete("/push/subscriptions/:id", (c) => {
  c.env.agent.services.push.unsubscribe(c.req.param("id"));
  return c.body(null, 204);
});

/** Sends a test message now and reports what the push service answered, per device. */
pushRoutes.post("/push/test", async (c) => {
  const push = c.env.agent.services.push;
  if (!push.enabled) throw new AppError("NOT_CONFIGURED", "Device notifications are not set up on this install (no VAPID keys).");
  const { id } = await body(c, z.object({ id: z.string().max(64).optional() }));
  const agentName = c.env.agent.services.settings.get().agentName;
  const results = await push.sendNow(
    { kind: "test", title: agentName, body: "Device notifications are working. This is a test.", tag: `test-${Date.now()}`, url: "/settings" },
    id,
  );
  return c.json({ results: results.map((r) => ({ id: r.id, label: r.label, ok: r.ok, status: r.status, gone: r.gone })) });
});

// ---------- Native push (the Android app, Firebase Cloud Messaging) ----------

const deviceRegisterSchema = z.object({
  token: z.string().min(20).max(4096),
  platform: z.enum(["android", "ios"]).default("android"),
  label: z.string().max(80).optional(),
  prefs: pushPrefsSchema.optional(),
});

function nativePush(c: { env: AppEnv["Bindings"] }) {
  const native = c.env.agent.services.push.native;
  if (!native) throw new AppError("NOT_CONFIGURED", "Native push is not set up on this install (no Firebase service account).");
  return native;
}

/** Whether native push is configured and which phones are registered. */
pushRoutes.get("/push/native", (c) => {
  const native = c.env.agent.services.push.native;
  return c.json({ enabled: native?.enabled ?? false, devices: native?.list() ?? [] });
});

/** Registers this phone's FCM token (idempotent per token) and returns its row. */
pushRoutes.post("/push/devices", async (c) => {
  const native = nativePush(c);
  if (!native.enabled) throw new AppError("NOT_CONFIGURED", "Native push is not set up on this install (no Firebase service account).");
  const input = await body(c, deviceRegisterSchema);
  return c.json({ device: native.register(input) }, 201);
});

pushRoutes.patch("/push/devices/:id", async (c) => {
  const patch = await body(c, pushPrefsSchema);
  const device = nativePush(c).setPrefs(c.req.param("id"), patch);
  if (!device) throw new NotFoundError("This phone is no longer registered.");
  return c.json({ device });
});

pushRoutes.delete("/push/devices/:id", (c) => {
  nativePush(c).unregister(c.req.param("id"));
  return c.body(null, 204);
});

/** Sends a test message through FCM now and reports what FCM answered, per phone. */
pushRoutes.post("/push/devices/test", async (c) => {
  const native = nativePush(c);
  if (!native.enabled) throw new AppError("NOT_CONFIGURED", "Native push is not set up on this install (no Firebase service account).");
  const { id } = await body(c, z.object({ id: z.string().max(64).optional() }));
  const agentName = c.env.agent.services.settings.get().agentName;
  const results = await native.sendNow({ kind: "test", title: agentName, body: "Notifications are working on this phone. This is a test.", tag: `test-${Date.now()}`, url: "/settings" }, id);
  return c.json({ ok: results.every((r) => r.ok), results: results.map((r) => ({ id: r.id, label: r.label, ok: r.ok, status: r.status, gone: r.gone, name: r.name, error: r.ok ? undefined : r.body })) });
});
