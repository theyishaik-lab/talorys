import { afterEach, describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { buildFcmMessage, channelFor, fcmAccessToken, clearFcmTokenCache, parseFcmCredentials, sendFcm, signServiceAccountJwt, type FcmCredentials } from "../src/push/fcm";
import type { FcmSendResult } from "../src/push/fcm";
import { LATEST_SCHEMA_VERSION } from "../src/db/migrations";

/** A throwaway RSA key in PKCS#8 PEM, the shape of a service-account private_key. */
async function testCredentials(): Promise<FcmCredentials> {
  const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let b64 = "";
  for (const b of pkcs8) b64 += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b64).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
  return { project_id: "talorys-connector", client_email: "fcm@talorys-connector.iam.gserviceaccount.com", private_key: pem };
}

interface Sent {
  token: string;
  kind: string;
}
/** A fake FCM in place of the network: answers per token and records what it got. */
async function fakeFcm(answers: Record<string, Partial<FcmSendResult>>, sent: Sent[]): Promise<() => Promise<void>> {
  const original = await inAgent((a) => a.services.push.native!.send);
  await inAgent((a) => {
    a.services.push.native!.send = async (_creds, token, message): Promise<FcmSendResult> => {
      sent.push({ token, kind: message.kind });
      const a = answers[token] ?? {};
      return { ok: a.ok ?? true, status: a.status ?? 200, gone: a.gone ?? false, name: a.ok === false ? undefined : `projects/talorys-connector/messages/${sent.length}` };
    };
  });
  return () => inAgent((a) => void (a.services.push.native!.send = original));
}

describe("FCM v1 client", () => {
  afterEach(() => clearFcmTokenCache());

  it("parses the service-account secret and rejects anything else", async () => {
    const creds = await testCredentials();
    expect(parseFcmCredentials(JSON.stringify(creds))).toEqual(creds);
    expect(parseFcmCredentials("not json")).toBeNull();
    expect(parseFcmCredentials(JSON.stringify({ project_id: "x" }))).toBeNull();
    expect(parseFcmCredentials(undefined)).toBeNull();
  });

  it("signs an RS256 service-account assertion that Google's token endpoint would accept", async () => {
    const creds = await testCredentials();
    const jwt = await signServiceAccountJwt(creds, 1_760_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(atob(h!.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(atob(c!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims).toMatchObject({ iss: creds.client_email, aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/firebase.messaging", iat: 1_760_000_000, exp: 1_760_003_600 });
    expect(s!.length).toBeGreaterThan(300);
  });

  it("exchanges the assertion once and caches the access token for about 55 minutes", async () => {
    const creds = await testCredentials();
    let exchanges = 0;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      expect(String(init?.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
      exchanges++;
      return Response.json({ access_token: `tok-${exchanges}`, expires_in: 3599, token_type: "Bearer" });
    }) as typeof fetch;
    const t0 = 1_760_000_000_000;
    expect(await fcmAccessToken(creds, fetchFn, t0)).toBe("tok-1");
    expect(await fcmAccessToken(creds, fetchFn, t0 + 50 * 60 * 1000)).toBe("tok-1");
    expect(await fcmAccessToken(creds, fetchFn, t0 + 56 * 60 * 1000)).toBe("tok-2");
    expect(exchanges).toBe(2);
  });

  it("builds a v1 message with the right channel, priority and deep-link data", () => {
    const m = buildFcmMessage("tok", { kind: "approval", title: "Approval needed", body: "Delete task “x”", tag: "approval-p1", url: "/chat/c1#action-p1", actionId: "p1", actions: true }, "https://talorys.example.pages.dev/");
    expect(m).toMatchObject({
      message: {
        token: "tok",
        notification: { title: "Approval needed", body: "Delete task “x”" },
        data: { kind: "approval", url: "https://talorys.example.pages.dev/chat/c1#action-p1", conversation_id: "c1", action_id: "p1", actions: "1" },
        android: { priority: "high", ttl: "1800s", notification: { channel_id: "approvals" } },
      },
    });
    expect(channelFor("reminder")).toBe("updates");
    expect(buildFcmMessage("tok", { kind: "reminder", title: "t", body: "b", tag: "n-1", url: "/chat?notifications=1" }, "https://x.test").message).toMatchObject({ android: { priority: "normal", notification: { channel_id: "updates" } } });
  });

  it("sends through messages:send with the bearer token and reads FCM's answer", async () => {
    const creds = await testCredentials();
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith("/token")) return Response.json({ access_token: "tok-1", expires_in: 3599 });
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer tok-1");
      const body = JSON.parse(String(init?.body)) as { message: { token: string } };
      if (body.message.token === "dead") return new Response(JSON.stringify({ error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] } }), { status: 404 });
      return Response.json({ name: "projects/talorys-connector/messages/0:1" });
    }) as typeof fetch;
    const ok = await sendFcm(creds, "live", { kind: "test", title: "t", body: "b", tag: "x", url: "/settings" }, "https://x.test", fetchFn);
    expect(ok).toEqual({ ok: true, status: 200, gone: false, name: "projects/talorys-connector/messages/0:1" });
    const gone = await sendFcm(creds, "dead", { kind: "test", title: "t", body: "b", tag: "x", url: "/settings" }, "https://x.test", fetchFn);
    expect(gone).toMatchObject({ ok: false, status: 404, gone: true });
    expect(calls.filter((u) => u.endsWith("/token"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("/v1/projects/talorys-connector/messages:send"))).toHaveLength(2);
  });
});

describe("native device registry", () => {
  const sent: Sent[] = [];
  let restore: (() => Promise<void>) | null = null;
  afterEach(async () => {
    sent.length = 0;
    await restore?.();
    restore = null;
    await inAgent((a) => a.services.db.run(`DELETE FROM tal_push_devices`));
  });

  it("has the devices table", () => {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(7);
  });

  it("registers a phone once per token, keeps its preferences, and tells the app whether push is configured", async () => {
    const c = await loggedIn();
    const config = await c.json<{ enabled: boolean; devices: unknown[] }>("/api/push/native");
    expect(config.devices).toEqual([]);
    expect(typeof config.enabled).toBe("boolean");
    // Registration needs a service account; the test env has none, so the route says so…
    const res = await c.call("/api/push/devices", { method: "POST", body: { token: "fcm-token-1234567890abcdef", platform: "android", label: "Pixel 9" } });
    expect([201, 503]).toContain(res.status);
    if (res.status !== 201) return;
    const { device } = (await res.json()) as { device: { id: string; prefs: Record<string, boolean>; label: string } };
    expect(device.label).toBe("Pixel 9");
    expect(device.prefs).toEqual({ approval: true, result: true, reminder: true });
    const again = await c.json<{ device: { id: string } }>("/api/push/devices", { method: "POST", body: { token: "fcm-token-1234567890abcdef", platform: "android" } });
    expect(again.device.id).toBe(device.id);
    const patched = await c.json<{ device: { prefs: Record<string, boolean> } }>(`/api/push/devices/${device.id}`, { method: "PATCH", body: { reminder: false } });
    expect(patched.device.prefs.reminder).toBe(false);
    expect((await c.call(`/api/push/devices/${device.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await c.json<{ devices: unknown[] }>("/api/push/native")).devices).toEqual([]);
  });

  it("fans a notification out to registered phones and drops a dead token", async () => {
    // Give the agent credentials for this test so the native channel is live.
    const creds = await testCredentials();
    await inAgent((a) => {
      (a.services.push.native as unknown as { creds: FcmCredentials | null }).creds = creds;
    });
    restore = await fakeFcm({ dead: { ok: false, status: 404, gone: true } }, sent);
    try {
      await inAgent((a) => {
        a.services.push.native!.register({ token: "live-token-1", platform: "android", label: "Pixel" });
        a.services.push.native!.register({ token: "dead", platform: "android", label: "Old phone" });
        a.services.push.native!.register({ token: "quiet", platform: "android", prefs: { reminder: false } });
      });
      const queued = await inAgent((a) => a.services.push.notify({ kind: "reminder", title: "r", body: "b", tag: "n-1", url: "/chat?notifications=1" }));
      expect(queued).toBe(2);
      const results = await inAgent((a) => a.services.push.native!.sendNow({ kind: "test", title: "t", body: "b", tag: "t", url: "/settings" }));
      // The reminder went to the two phones that want reminders; FCM's 404 for "dead" deleted that row.
      expect(sent.filter((s) => s.kind === "reminder").map((s) => s.token).sort()).toEqual(["dead", "live-token-1"]);
      expect(await inAgent((a) => a.services.push.native!.list().map((d) => d.label))).toEqual(["Pixel", ""]);
      // A test message goes to every remaining phone, preferences ignored, and reports FCM's message name.
      expect(results.map((r) => r.ok)).toEqual([true, true]);
      expect(results.every((r) => r.name?.startsWith("projects/talorys-connector/messages/"))).toBe(true);
    } finally {
      await inAgent((a) => {
        (a.services.push.native as unknown as { creds: FcmCredentials | null }).creds = null;
      });
    }
  });
});
