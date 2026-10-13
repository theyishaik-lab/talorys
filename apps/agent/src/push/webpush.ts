/**
 * Web Push for Cloudflare Workers, with WebCrypto only.
 *
 * - RFC 8291 payload encryption (aes128gcm): ECDH P-256 + HKDF-SHA256 + AES-128-GCM.
 * - RFC 8292 VAPID: an ES256 JWT per push-service origin, cached for most of its lifetime so a
 *   push costs one ECDH, three HKDF rounds and one AES-GCM — well under a millisecond of CPU.
 *
 * The `web-push` npm package needs node:crypto and node:https, which Workers do not provide;
 * this file is the whole replacement. Test vectors: RFC 8291 Appendix A (`webpush.test.ts`).
 */

export interface PushKeys {
  /** Base64url, 65-byte uncompressed P-256 point. */
  publicKey: string;
  /** Base64url, 32-byte scalar. */
  privateKey: string;
  /** `mailto:` or `https:` contact for the push service. */
  subject: string;
}

export interface PushTarget {
  endpoint: string;
  /** Base64url, the browser's 65-byte P-256 public key. */
  p256dh: string;
  /** Base64url, the browser's 16-byte auth secret. */
  auth: string;
}

export interface SendOptions {
  /** Seconds the push service keeps the message for an offline device. */
  ttl?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  /** Messages with the same topic replace each other while queued at the push service. */
  topic?: string;
}

export interface SendResult {
  ok: boolean;
  status: number;
  /** The subscription is gone (404/410): delete it. */
  gone: boolean;
  body?: string;
}

const encoder = new TextEncoder();

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function buf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** JWK for a P-256 key from its raw uncompressed public point and (optionally) its scalar. */
export function p256Jwk(publicKey: Uint8Array, privateKey?: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("A P-256 public key must be a 65-byte uncompressed point.");
  if (privateKey && privateKey.length !== 32) throw new Error("A P-256 private key must be 32 bytes.");
  return {
    kty: "EC",
    crv: "P-256",
    x: toBase64Url(publicKey.slice(1, 33)),
    y: toBase64Url(publicKey.slice(33, 65)),
    ...(privateKey ? { d: toBase64Url(privateKey) } : {}),
  };
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: buf(salt), info: buf(info) }, key, length * 8);
  return new Uint8Array(bits);
}

export interface EncryptOptions {
  /** Fixed sender key pair and salt, for the RFC test vectors only. */
  senderPrivateKey?: Uint8Array;
  senderPublicKey?: Uint8Array;
  salt?: Uint8Array;
}

/** RFC 8291 §3 + RFC 8188: one aes128gcm record carrying the whole payload. */
export async function encryptPayload(target: Pick<PushTarget, "p256dh" | "auth">, plaintext: Uint8Array, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const uaPublic = fromBase64Url(target.p256dh);
  const authSecret = fromBase64Url(target.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("Invalid subscription keys.");

  let asPublic: Uint8Array;
  let asPrivateKey: CryptoKey;
  if (opts.senderPrivateKey && opts.senderPublicKey) {
    asPublic = opts.senderPublicKey;
    asPrivateKey = await crypto.subtle.importKey("jwk", p256Jwk(asPublic, opts.senderPrivateKey), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  } else {
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
    asPrivateKey = pair.privateKey;
  }
  const uaKey = await crypto.subtle.importKey("raw", buf(uaPublic), { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Workers' types spell the ECDH peer key `$public`; the runtime reads `public`.
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, asPrivateKey, 256));

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const ikm = await hkdf(authSecret, ecdh, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  if (plaintext.length > 4000) throw new Error("Push payloads must stay under 4 KB.");
  const padded = concat(plaintext, new Uint8Array([2])); // 0x02 = last record delimiter, no padding
  const aes = await crypto.subtle.importKey("raw", buf(cek), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce) }, aes, buf(padded)));

  const recordSize = 4096; // RFC 8188 record size; one record holds the whole (small) payload
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

interface CachedJwt {
  token: string;
  /** Unix seconds after which a fresh token is minted (well before the JWT's own expiry). */
  renewAt: number;
}

/** One cache per isolate: a token per push-service origin, renewed after 12 h of a 24 h life. */
const jwtCache = new Map<string, CachedJwt>();
let signingKey: { source: string; key: CryptoKey } | null = null;

export function clearVapidCache(): void {
  jwtCache.clear();
  signingKey = null;
}

async function vapidSigningKey(keys: PushKeys): Promise<CryptoKey> {
  const source = `${keys.publicKey}:${keys.privateKey}`;
  if (signingKey?.source === source) return signingKey.key;
  const jwk = p256Jwk(fromBase64Url(keys.publicKey), fromBase64Url(keys.privateKey));
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  signingKey = { source, key };
  return key;
}

/** RFC 8292 §2: `vapid t=<jwt>, k=<public key>` for the push service at `audience`. */
export async function vapidAuthorization(keys: PushKeys, audience: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const cacheKey = `${audience}|${keys.publicKey}`;
  const cached = jwtCache.get(cacheKey);
  if (cached && cached.renewAt > nowSeconds) return `vapid t=${cached.token}, k=${keys.publicKey}`;

  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = nowSeconds + 24 * 3600 - 60;
  const claims = toBase64Url(encoder.encode(JSON.stringify({ aud: audience, exp, sub: keys.subject })));
  const signingInput = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, await vapidSigningKey(keys), buf(encoder.encode(signingInput)));
  const token = `${signingInput}.${toBase64Url(sig)}`; // WebCrypto's ECDSA output is already raw r||s, as JWS wants
  jwtCache.set(cacheKey, { token, renewAt: nowSeconds + 12 * 3600 });
  return `vapid t=${token}, k=${keys.publicKey}`;
}

/** Encrypts and posts one message to a subscription's push service. Never throws on HTTP errors. */
export async function sendPush(keys: PushKeys, target: PushTarget, payload: string, opts: SendOptions = {}, fetchFn: typeof fetch = fetch): Promise<SendResult> {
  const audience = new URL(target.endpoint).origin;
  const body = await encryptPayload(target, encoder.encode(payload));
  const headers: Record<string, string> = {
    authorization: await vapidAuthorization(keys, audience),
    "content-type": "application/octet-stream",
    "content-encoding": "aes128gcm",
    ttl: String(opts.ttl ?? 24 * 3600),
    urgency: opts.urgency ?? "normal",
  };
  if (opts.topic) headers.topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  let res: Response;
  try {
    res = await fetchFn(target.endpoint, { method: "POST", headers, body: buf(body) });
  } catch (error) {
    return { ok: false, status: 0, gone: false, body: error instanceof Error ? error.message : String(error) };
  }
  const gone = res.status === 404 || res.status === 410;
  return { ok: res.ok, status: res.status, gone, ...(res.ok ? {} : { body: (await res.text().catch(() => "")).slice(0, 200) }) };
}

/** A fresh VAPID key pair (installer and tests). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = toBase64Url((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  if (!jwk.d) throw new Error("Key export failed.");
  return { publicKey, privateKey: jwk.d };
}
