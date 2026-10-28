import { afterEach, describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { clearVapidCache, encryptPayload, fromBase64Url, generateVapidKeys, p256Jwk, sendPush, toBase64Url, vapidAuthorization } from "../src/push/webpush";
import { excerpt, isLowRiskAction } from "../src/push/service";
import { LATEST_SCHEMA_VERSION } from "../src/db/migrations";
import { ALL_TOOLS, ToolExecutor, type ToolContext } from "../src/tools";
import type { PushTarget, SendResult } from "../src/push/webpush";

/** A fake push service in place of the network: answers per endpoint path and records what it got. */
interface Delivery {
  endpoint: string;
  payload: string;
  options: Record<string, unknown>;
}
async function fakePushService(answers: Record<string, number>, deliveries: Delivery[]): Promise<() => Promise<void>> {
  const original = await inAgent((a) => a.services.push.send);
  await inAgent((a) => {
    a.services.push.send = async (_keys, target: PushTarget, payload: string, options): Promise<SendResult> => {
      deliveries.push({ endpoint: target.endpoint, payload, options: { ...options } });
      const status = answers[new URL(target.endpoint).pathname] ?? 201;
      return { ok: status < 300, status, gone: status === 404 || status === 410 };
    };
  });
  return () => inAgent((a) => void (a.services.push.send = original));
}

/** RFC 8291 Appendix A: the one published end-to-end example, keys and salt fixed. */
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** A browser-side subscription: the device's keys, able to decrypt what the Worker sends (RFC 8291 §3). */
async function fakeDevice() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const p256dh = toBase64Url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const auth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
  const decrypt = async (body: Uint8Array): Promise<string> => {
    const salt = body.slice(0, 16);
    const idlen = body[20]!;
    const asPublic = body.slice(21, 21 + idlen);
    const ciphertext = body.slice(21 + idlen);
    const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, pair.privateKey, 256));
    const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) => {
      const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
      return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: s, info }, k, len * 8));
    };
    const enc = new TextEncoder();
    const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...fromBase64Url(p256dh), ...asPublic]);
    const ikm = await hkdf(fromBase64Url(auth), ecdh, info, 32);
    const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
    const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
    const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
    const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
    expect(padded[padded.length - 1]).toBe(2);
    return new TextDecoder().decode(padded.slice(0, -1));
  };
  return { p256dh, auth, decrypt };
}

describe("RFC 8291 encryption and RFC 8292 VAPID (WebCrypto only)", () => {
  it("reproduces the RFC 8291 Appendix A ciphertext byte for byte", async () => {
    const body = await encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, new TextEncoder().encode(RFC.plaintext), {
      senderPrivateKey: fromBase64Url(RFC.asPrivate),
      senderPublicKey: fromBase64Url(RFC.asPublic),
      salt: fromBase64Url(RFC.salt),
    });
    expect(toBase64Url(body)).toBe(RFC.body);
  });

  it("a device with the matching private key decrypts a message encrypted with a fresh sender key", async () => {
    const device = await fakeDevice();
    const body = await encryptPayload(device, new TextEncoder().encode(JSON.stringify({ title: "שלום", body: "x".repeat(900) })));
    expect(JSON.parse(await device.decrypt(body))).toEqual({ title: "שלום", body: "x".repeat(900) });
  });

  it("signs an ES256 VAPID JWT the public key verifies, and caches it per push service", async () => {
    clearVapidCache();
    const keys = { ...(await generateVapidKeys()), subject: "mailto:owner@example.com" };
    const header = await vapidAuthorization(keys, "https://fcm.googleapis.com", 1_700_000_000);
    const m = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(m[2]).toBe(keys.publicKey);
    const [h, c, sig] = m[1]!.split(".");
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(c!)));
    expect(claims).toEqual({ aud: "https://fcm.googleapis.com", exp: 1_700_000_000 + 86_340, sub: "mailto:owner@example.com" });
    const verifyKey = await crypto.subtle.importKey("jwk", p256Jwk(fromBase64Url(keys.publicKey)), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, fromBase64Url(sig!), new TextEncoder().encode(`${h}.${c}`))).toBe(true);
    // The same token is reused for 12 h, a new one after that, and another origin gets its own.
    expect(await vapidAuthorization(keys, "https://fcm.googleapis.com", 1_700_000_000 + 11 * 3600)).toBe(header);
    expect(await vapidAuthorization(keys, "https://fcm.googleapis.com", 1_700_000_000 + 13 * 3600)).not.toBe(header);
    expect(await vapidAuthorization(keys, "https://updates.push.services.mozilla.com", 1_700_000_000)).not.toBe(header);
  });

  it("posts the encrypted body with the Web Push headers and reads the service's answer", async () => {
    const keys = { ...(await generateVapidKeys()), subject: "mailto:owner@example.com" };
    const device = await fakeDevice();
    let seen: { headers: Record<string, string>; body: Uint8Array } | null = null;
    const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = { headers: Object.fromEntries(Object.entries(init?.headers ?? {})), body: new Uint8Array(init?.body as ArrayBuffer) };
      return new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    const ok = await sendPush(keys, { endpoint: "https://push.example/send/abc", ...device }, '{"kind":"test"}', { ttl: 60, urgency: "high", topic: "approval-1" }, fetchFn);
    expect(ok).toEqual({ ok: true, status: 201, gone: false });
    expect(seen!.headers).toMatchObject({ "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "60", urgency: "high", topic: "approval-1" });
    expect(seen!.headers.authorization).toMatch(/^vapid t=.+, k=/);
    expect(await device.decrypt(seen!.body)).toBe('{"kind":"test"}');

    const gone = await sendPush(keys, { endpoint: "https://push.example/send/abc", ...device }, "x", {}, (async () => new Response("gone", { status: 410 })) as unknown as typeof fetch);
    expect(gone).toMatchObject({ ok: false, status: 410, gone: true, body: "gone" });
    const down = await sendPush(keys, { endpoint: "https://push.example/send/abc", ...device }, "x", {}, (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch);
    expect(down).toMatchObject({ ok: false, status: 0, gone: false, body: "ECONNRESET" });
  });

  it("generates a usable VAPID pair", async () => {
    const k = await generateVapidKeys();
    expect(fromBase64Url(k.publicKey)).toHaveLength(65);
    expect(fromBase64Url(k.privateKey)).toHaveLength(32);
  });
});

describe("which approvals may be answered from the notification", () => {
  it("only low-risk additions get Approve/Decline buttons", () => {
    const run = (action: string) => JSON.stringify({ action, input: {} });
    expect(isLowRiskAction("propose_action", run("googletasks.insert_task"))).toBe(true);
    expect(isLowRiskAction("propose_action", run("googlecalendar.create_event"))).toBe(true);
    expect(isLowRiskAction("propose_action", run("notion.create_page"))).toBe(true);
    expect(isLowRiskAction("propose_action", run("gmail.send_email"))).toBe(false);
    expect(isLowRiskAction("propose_action", run("gmail.create_draft"))).toBe(false);
    expect(isLowRiskAction("propose_action", run("googledrive.delete_file"))).toBe(false);
    expect(isLowRiskAction("propose_action", run("github.create_issue"))).toBe(true);
    expect(isLowRiskAction("propose_action", run("slack.post_message"))).toBe(false);
    expect(isLowRiskAction("propose_action", "not json")).toBe(false);
    expect(isLowRiskAction("connect_service", JSON.stringify({ service: "notion" }))).toBe(false);
    expect(isLowRiskAction("delete_task", "t1")).toBe(false);
    expect(isLowRiskAction("delete_note", "n1")).toBe(false);
  });

  it("excerpt keeps a notification body to one phone-sized line", () => {
    expect(excerpt("  Hello\n\nworld  ")).toBe("Hello world");
    expect(excerpt("a".repeat(500))).toHaveLength(400);
    expect(excerpt("a".repeat(500)).endsWith("…")).toBe(true);
  });
});

describe("push subscriptions API", () => {
  let restore: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await restore?.();
    restore = null;
  });

  const sub = (endpoint: string, device: { p256dh: string; auth: string }, label = "Pixel") => ({ endpoint, keys: { p256dh: device.p256dh, auth: device.auth }, label });

  it("schema includes the push table", async () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    const c = await loggedIn();
    expect(await c.json("/api/push/config")).toMatchObject({ enabled: true, public_key: expect.stringMatching(/^B[A-Za-z0-9_-]{86}$/) });
  });

  it("registers a device once per endpoint, keeps its preferences, and forgets it on delete", async () => {
    const c = await loggedIn();
    const device = await fakeDevice();
    const res = await c.call("/api/push/subscriptions", { method: "POST", body: sub("https://push.example/send/one", device) });
    expect(res.status).toBe(201);
    const { subscription } = (await res.json()) as any;
    expect(subscription).toMatchObject({ label: "Pixel", prefs: { approval: true, result: true, reminder: true }, failures: 0 });
    expect(subscription.endpoint).toBeUndefined(); // the endpoint never leaves the server

    const again = await c.json("/api/push/subscriptions", { method: "POST", body: { ...sub("https://push.example/send/one", device), prefs: { reminder: false } } });
    expect(again.subscription.id).toBe(subscription.id);
    expect(again.subscription.prefs).toEqual({ approval: true, result: true, reminder: false });
    expect((await c.json("/api/push/subscriptions")).subscriptions.filter((s: any) => s.id === subscription.id)).toHaveLength(1);

    const found = await c.json("/api/push/subscriptions/lookup", { method: "POST", body: { endpoint: "https://push.example/send/one" } });
    expect(found.subscription.id).toBe(subscription.id);

    const patched = await c.json(`/api/push/subscriptions/${subscription.id}`, { method: "PATCH", body: { approval: false } });
    expect(patched.subscription.prefs).toEqual({ approval: false, result: true, reminder: false });

    expect((await c.call(`/api/push/subscriptions/${subscription.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await c.json("/api/push/subscriptions/lookup", { method: "POST", body: { endpoint: "https://push.example/send/one" } })).subscription).toBeNull();
    expect((await c.call("/api/push/subscriptions", { method: "POST", body: { endpoint: "http://insecure.example/x", keys: { p256dh: device.p256dh, auth: device.auth } } })).status).toBe(400);
  });

  it("the test button sends an encrypted push the device can read, and a dead endpoint is dropped", async () => {
    const c = await loggedIn();
    const live = await fakeDevice();
    const dead = await fakeDevice();
    const a = await c.json("/api/push/subscriptions", { method: "POST", body: sub("https://push.example/send/live", live, "Phone") });
    const b = await c.json("/api/push/subscriptions", { method: "POST", body: sub("https://push.example/send/dead", dead, "Old phone") });

    const deliveries: Delivery[] = [];
    restore = await fakePushService({ "/send/dead": 410 }, deliveries);

    const { results } = await c.json("/api/push/test", { method: "POST" });
    expect(results).toEqual(expect.arrayContaining([
      { id: a.subscription.id, label: "Phone", ok: true, status: 201, gone: false },
      { id: b.subscription.id, label: "Old phone", ok: false, status: 410, gone: true },
    ]));
    const toLive = deliveries.find((d) => d.endpoint.endsWith("/live"))!;
    expect(JSON.parse(toLive.payload)).toMatchObject({ kind: "test", title: expect.any(String), url: "/settings" });
    expect(toLive.options).toMatchObject({ urgency: "normal", ttl: 86_400 });
    // The real transport encrypts exactly this payload for exactly this device (covered byte-for-byte above).
    expect(await live.decrypt(await encryptPayload(live, new TextEncoder().encode(toLive.payload)))).toBe(toLive.payload);
    const left = (await c.json("/api/push/subscriptions")).subscriptions.map((s: any) => s.id);
    expect(left).toContain(a.subscription.id);
    expect(left).not.toContain(b.subscription.id);
    await c.call(`/api/push/subscriptions/${a.subscription.id}`, { method: "DELETE" });
  });

  it("a proposed action pushes an approval request; the bell's notifications push too, each per the device's preferences", async () => {
    const c = await loggedIn();
    const device = await fakeDevice();
    const { subscription } = await c.json("/api/push/subscriptions", { method: "POST", body: sub("https://push.example/send/phone", device, "Phone") });
    const deliveries: Delivery[] = [];
    restore = await fakePushService({}, deliveries);

    await inAgent(async (agent) => {
      const s = agent.services;
      const conversation = s.conversations.create("push test");
      const task = s.tasks.create({ title: "Buy milk", description: "", status: "todo", priority: "medium", due_at: null, project_id: null });
      const ctx: ToolContext = { services: s, timezone: "UTC", mode: "chat", conversationId: conversation.id };
      const sent: unknown[] = [];
      // Capture what was queued through the push service (the Durable Object's waitUntil runs it).
      const notify = s.push.notify.bind(s.push);
      s.push.notify = (m) => {
        sent.push(m);
        return notify(m);
      };
      const executor = new ToolExecutor(ALL_TOOLS, ctx, { maxToolCalls: 5 });
      await executor.execute("delete_task", { task: task.id }, "call-1");
      const approval = executor.approvalFor("call-1")!;
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        kind: "approval",
        title: "Approval needed",
        body: expect.stringContaining("Buy milk"),
        tag: `approval-${approval.id}`,
        url: `/chat/${conversation.id}#action-${approval.id}`,
        actionId: approval.id,
        actions: false, // deleting is never approved from a notification
      });

      // A bell notification from an automation is a "reminder" push; "Done" after an approval is a "result".
      s.notifications.create({ title: "Reminder", body: "Drink water\nnow", automation_id: null });
      expect(sent[1]).toMatchObject({ kind: "reminder", title: "Reminder", body: "Drink water now", url: "/chat/updates-inbox" });
      // The tap opens a real thread holding the full text.
      expect(s.conversations.get("updates-inbox")?.title).toBe("Notifications");
      expect(s.conversations.messages("updates-inbox").at(-1)).toMatchObject({ role: "assistant", content: "**Reminder**\n\nDrink water\nnow" });
      // A device that turned results off gets no result push (nothing queued → no interceptor consumed).
      s.push.setPrefs(subscription.id, { result: false });
      s.notifications.create({ title: "Done", body: "Sent", kind: "result" });
      expect(sent[2]).toMatchObject({ kind: "result" });
      s.push.notify = notify;
    });
    // Give the queued deliveries a moment: two reached the device, the result one was filtered out.
    await new Promise((r) => setTimeout(r, 300));
    expect(deliveries.map((d) => String(d.options.topic)).sort()).toEqual([expect.stringMatching(/^approval-/), expect.stringMatching(/^notification-/)]);
    expect(deliveries.find((d) => String(d.options.topic).startsWith("approval-"))?.options).toMatchObject({ urgency: "high", ttl: 1800 });
    await c.call(`/api/push/subscriptions/${subscription.id}`, { method: "DELETE" });
  });
});
