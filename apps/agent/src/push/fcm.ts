/**
 * Firebase Cloud Messaging, HTTP v1, from a Worker: the service-account JWT is signed with WebCrypto
 * (RS256), exchanged for an OAuth access token that is cached for ~55 minutes, and each message is one
 * POST to messages:send. No Firebase SDK, no Node crypto. The native app (apps/mobile) registers its
 * FCM device token with the agent; see push/native.ts.
 */
import type { PushMessage } from "./service";

export interface FcmCredentials {
  project_id: string;
  client_email: string;
  /** PKCS#8 PEM, as in the service-account JSON. */
  private_key: string;
}

export interface FcmSendResult {
  ok: boolean;
  status: number;
  /** FCM says the token is no longer valid (UNREGISTERED / 404): delete the device. */
  gone: boolean;
  /** `projects/<id>/messages/<id>` on success. */
  name?: string;
  body?: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_TTL_MS = 55 * 60 * 1000;

/** Parses the FCM_SERVICE_ACCOUNT secret (the service-account JSON, verbatim). */
export function parseFcmCredentials(raw: string | undefined): FcmCredentials | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Partial<FcmCredentials>;
    if (typeof j.project_id === "string" && typeof j.client_email === "string" && typeof j.private_key === "string") {
      return { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key };
    }
  } catch {
    /* not JSON */
  }
  return null;
}

const b64url = (bytes: ArrayBuffer | Uint8Array | string): string => {
  const u8 = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----/g, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** A signed service-account assertion (RFC 7523), valid for one hour. */
export async function signServiceAccountJwt(creds: FcmCredentials, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 }));
  const key = await crypto.subtle.importKey("pkcs8", pemToPkcs8(creds.private_key), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(signature)}`;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
const tokenCache = new Map<string, CachedToken>();

/** An OAuth access token for FCM, cached per service account for 55 minutes (Google issues 60). */
export async function fcmAccessToken(creds: FcmCredentials, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<string> {
  const cached = tokenCache.get(creds.client_email);
  if (cached && cached.expiresAt > now) return cached.token;
  const assertion = await signServiceAccountJwt(creds, Math.floor(now / 1000));
  const res = await fetchFn(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  if (!res.ok) throw new Error(`FCM token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  const ttl = Math.min(TOKEN_TTL_MS, ((json.expires_in ?? 3600) - 300) * 1000);
  tokenCache.set(creds.client_email, { token: json.access_token, expiresAt: now + ttl });
  return json.access_token;
}

export function clearFcmTokenCache(): void {
  tokenCache.clear();
}

/** Android notification channels the app creates (apps/mobile/src/lib/push.ts): approvals ring, updates don't. */
export function channelFor(kind: PushMessage["kind"]): "approvals" | "updates" {
  return kind === "approval" ? "approvals" : "updates";
}

/** The FCM v1 message for a device token: a tray notification plus data the app reads on tap. */
export function buildFcmMessage(token: string, message: PushMessage, deepLinkBase: string): Record<string, unknown> {
  const url = `${deepLinkBase.replace(/\/+$/, "")}${message.url.startsWith("/") ? message.url : `/${message.url}`}`;
  const conversation = message.url.match(/\/chat\/([A-Za-z0-9_-]+)/)?.[1];
  return {
    message: {
      token,
      notification: { title: message.title, body: message.body },
      data: {
        kind: message.kind,
        url,
        tag: message.tag,
        ...(conversation ? { conversation_id: conversation } : {}),
        ...(message.actionId ? { action_id: message.actionId } : {}),
        ...(message.actions ? { actions: "1" } : {}),
      },
      android: {
        priority: message.kind === "approval" ? "high" : "normal",
        ttl: `${message.kind === "approval" ? 1800 : 86400}s`,
        collapse_key: message.tag.slice(0, 64),
        notification: { channel_id: channelFor(message.kind), tag: message.tag, notification_count: 1 },
      },
    },
  };
}

/** One send. 404 / UNREGISTERED means the token is dead. */
export async function sendFcm(creds: FcmCredentials, token: string, message: PushMessage, deepLinkBase: string, fetchFn: typeof fetch = fetch): Promise<FcmSendResult> {
  let accessToken: string;
  try {
    accessToken = await fcmAccessToken(creds, fetchFn);
  } catch (error) {
    return { ok: false, status: 0, gone: false, body: error instanceof Error ? error.message : String(error) };
  }
  const res = await fetchFn(`https://fcm.googleapis.com/v1/projects/${creds.project_id}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(buildFcmMessage(token, message, deepLinkBase)),
  });
  const text = await res.text();
  if (res.ok) {
    let name: string | undefined;
    try {
      name = (JSON.parse(text) as { name?: string }).name;
    } catch {
      /* no body */
    }
    return { ok: true, status: res.status, gone: false, name };
  }
  if (res.status === 401) tokenCache.delete(creds.client_email);
  const gone = res.status === 404 || /UNREGISTERED|NOT_FOUND|InvalidRegistration/.test(text);
  return { ok: false, status: res.status, gone, body: text.slice(0, 300) };
}
