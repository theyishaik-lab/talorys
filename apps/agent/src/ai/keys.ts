import { fromBase64Url, toBase64Url } from "@talorys/shared";
import type { AiProviderId } from "@talorys/shared";
import type { SettingsService } from "../services/settings";

/**
 * API keys for the non-Cloudflare providers (Gemini, OpenRouter), stored in `tal_settings` under
 * `ai.keys`, encrypted with AES-256-GCM. The encryption key is derived (HKDF-SHA-256) from the
 * Worker's SESSION_SECRET, so a database export alone cannot reveal them and a key is never sent
 * back to the browser: the API only ever returns the last four characters.
 */
export type KeyProvider = Extract<AiProviderId, "gemini" | "openrouter">;
/** A stored key: a provider's, or an OpenAI-compatible endpoint's (`endpoint:<id>`). */
export type KeyName = KeyProvider | `endpoint:${string}`;

interface StoredKey {
  iv: string;
  data: string;
  hint: string;
  added_at: string;
}

export interface KeyInfo {
  set: boolean;
  hint: string | null;
  added_at: string | null;
}

const STORE_KEY = "ai.keys";
const INFO = new TextEncoder().encode("talorys/ai-keys/v1");

export class ProviderKeyStore {
  private cryptoKey: Promise<CryptoKey> | null = null;
  private readonly cache = new Map<KeyName, string | null>();

  constructor(
    private readonly settings: SettingsService,
    private readonly secret: string | undefined,
  ) {}

  /** Keys can only be stored when the Worker has a SESSION_SECRET to encrypt them with. */
  get available(): boolean {
    return (this.secret?.length ?? 0) >= 16;
  }

  info(): Record<KeyProvider, KeyInfo> {
    const all = this.read();
    const one = (p: KeyProvider): KeyInfo => (all[p] ? { set: true, hint: all[p].hint, added_at: all[p].added_at } : { set: false, hint: null, added_at: null });
    return { gemini: one("gemini"), openrouter: one("openrouter") };
  }

  has(provider: KeyName): boolean {
    return !!this.read()[provider];
  }

  async get(provider: KeyName): Promise<string | null> {
    if (this.cache.has(provider)) return this.cache.get(provider) ?? null;
    const stored = this.read()[provider];
    if (!stored) return null;
    const key = await this.key();
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(stored.iv) as Uint8Array<ArrayBuffer> }, key, fromBase64Url(stored.data) as Uint8Array<ArrayBuffer>);
    const value = new TextDecoder().decode(plain);
    this.cache.set(provider, value);
    return value;
  }

  async set(provider: KeyName, value: string): Promise<KeyInfo> {
    const key = await this.key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
    const stored: StoredKey = { iv: toBase64Url(iv), data: toBase64Url(new Uint8Array(data)), hint: hintOf(value), added_at: new Date().toISOString() };
    this.settings.setJson(STORE_KEY, { ...this.read(), [provider]: stored });
    this.cache.set(provider, value);
    return { set: true, hint: stored.hint, added_at: stored.added_at };
  }

  delete(provider: KeyName): void {
    const all = this.read();
    delete all[provider];
    this.settings.setJson(STORE_KEY, all);
    this.cache.delete(provider);
  }

  /** The hint of any stored key (endpoint keys included). */
  infoOf(name: KeyName): KeyInfo {
    const k = this.read()[name];
    return k ? { set: true, hint: k.hint, added_at: k.added_at } : { set: false, hint: null, added_at: null };
  }

  private read(): Partial<Record<KeyName, StoredKey>> {
    return this.settings.getJson<Partial<Record<KeyName, StoredKey>>>(STORE_KEY) ?? {};
  }

  private key(): Promise<CryptoKey> {
    if (!this.cryptoKey) {
      if (!this.available) return Promise.reject(new Error("SESSION_SECRET is not set; provider keys cannot be stored."));
      this.cryptoKey = (async () => {
        const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.secret!), "HKDF", false, ["deriveKey"]);
        return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: INFO }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      })();
    }
    return this.cryptoKey;
  }
}

/** "…k2Q9": enough to recognise a key, never enough to use it. */
export function hintOf(value: string): string {
  return `…${value.slice(-4)}`;
}
