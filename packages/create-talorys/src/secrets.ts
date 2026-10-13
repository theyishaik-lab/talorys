import { generateKeyPairSync, randomBytes } from "node:crypto";
import { hashPassword } from "@talorys/shared/crypto";
import { checkPasswordStrength } from "@talorys/shared/password-policy";

export const PASSWORD_SECRET = "OWNER_PASSWORD_HASH";
export const SESSION_SECRET = "SESSION_SECRET";
/** Web Push (VAPID): one P-256 key pair per install, generated here, never shared between installs. */
export const VAPID_PUBLIC_SECRET = "VAPID_PUBLIC_KEY";
export const VAPID_PRIVATE_SECRET = "VAPID_PRIVATE_KEY";
export const VAPID_SUBJECT_SECRET = "VAPID_SUBJECT";
export const VAPID_SECRETS = [VAPID_PUBLIC_SECRET, VAPID_PRIVATE_SECRET, VAPID_SUBJECT_SECRET] as const;
export const REQUIRED_SECRETS = [PASSWORD_SECRET, SESSION_SECRET, ...VAPID_SECRETS] as const;

export function validatePassword(password: string | undefined): string | undefined {
  if (!password) return "Please enter a password.";
  return checkPasswordStrength(password) ?? undefined;
}

/** 256-bit random session key, base64url encoded. */
export function generateSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A VAPID key pair for Web Push (RFC 8292), in the form the agent Worker reads: the public key as
 * the 65-byte uncompressed P-256 point, the private key as the 32-byte scalar, both base64url.
 */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const priv = privateKey.export({ format: "jwk" }) as { d: string };
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, "base64url"), Buffer.from(pub.y, "base64url")]);
  if (point.length !== 65 || Buffer.from(priv.d, "base64url").length !== 32) throw new Error("Unexpected P-256 key shape.");
  return { publicKey: point.toString("base64url"), privateKey: priv.d };
}

/** The contact the push services see on every message, per RFC 8292 (`mailto:` or an https URL). */
export function vapidSubject(contact: string | null | undefined, publicUrl: string | null | undefined): string {
  const email = contact?.trim();
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return `mailto:${email}`;
  if (publicUrl?.startsWith("https://")) return publicUrl;
  return "mailto:owner@talorys.local";
}

/**
 * Builds the secret payload. The plaintext password is hashed locally with
 * PBKDF2-SHA256 and never leaves this machine. Only the secrets named in `include` are built.
 */
export async function buildOwnerSecrets(password: string, opts: { includeSessionSecret: boolean; includeVapid?: boolean; vapidSubject?: string }): Promise<Record<string, string>> {
  const secrets: Record<string, string> = { [PASSWORD_SECRET]: await hashPassword(password) };
  if (opts.includeSessionSecret) secrets[SESSION_SECRET] = generateSessionSecret();
  if (opts.includeVapid) {
    const keys = generateVapidKeys();
    secrets[VAPID_PUBLIC_SECRET] = keys.publicKey;
    secrets[VAPID_PRIVATE_SECRET] = keys.privateKey;
    secrets[VAPID_SUBJECT_SECRET] = opts.vapidSubject ?? "mailto:owner@talorys.local";
  }
  return secrets;
}
