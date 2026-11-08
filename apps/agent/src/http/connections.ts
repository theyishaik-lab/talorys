import { type ApiConnectionView, type HttpSettings, API_CONNECTION_ID, apiConnectionIdFromName, apiConnectionSchema } from "@talorys/shared";
import { AppError } from "../api/errors";
import type { KeyName, ProviderKeyStore } from "../ai/keys";
import type { SettingsService } from "../services/settings";

/**
 * The owner's saved API connections for `http_request`: name, base URL and the header that
 * carries the secret. Stored as JSON in `tal_settings` under `http.connections`; each secret is
 * stored apart, encrypted in the same AES-256-GCM key store the provider keys use (ai/keys.ts),
 * under `api:<id>`. Nothing here ever returns a secret, only its hint.
 */
const STORE_KEY = "http.connections";
const SETTINGS_KEY = "http.settings";
export const DEFAULT_HTTP_SETTINGS: HttpSettings = { confirmNonGet: true };

export interface ApiConnection {
  id: string;
  name: string;
  baseURL: string;
  authHeader: string;
}

export const apiSecretName = (id: string): KeyName => `api:${id}`;

type Stored = Record<string, Omit<ApiConnection, "id">>;

export class ApiConnectionStore {
  constructor(
    private readonly settings: Pick<SettingsService, "getJson" | "setJson">,
    private readonly keys: ProviderKeyStore,
  ) {}

  private read(): Stored {
    const v = this.settings.getJson<Stored>(STORE_KEY);
    return v && typeof v === "object" ? v : {};
  }

  list(): ApiConnection[] {
    return Object.entries(this.read())
      .map(([id, c]) => ({ id, ...c }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): ApiConnection | null {
    const c = this.read()[id];
    return c ? { id, ...c } : null;
  }

  /** A connection by id, or by its name (case- and space-insensitive), the way the model names it. */
  find(ref: string): ApiConnection | null {
    const byId = this.get(ref.trim());
    if (byId) return byId;
    const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
    const want = norm(ref);
    return this.list().find((c) => norm(c.name) === want) ?? null;
  }

  view(c: ApiConnection): ApiConnectionView {
    return { ...c, secret: this.keys.infoOf(apiSecretName(c.id)) };
  }

  /** A new id from the name (`Weather API` → `weather-api`), made unique; a random one for names with no latin letters. */
  newId(name: string): string {
    const all = this.read();
    let base = apiConnectionIdFromName(name);
    if (!API_CONNECTION_ID.test(base)) base = `api-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
    let id = base.slice(0, 28);
    for (let n = 2; id in all; n++) id = `${base.slice(0, 28)}-${n}`;
    return id;
  }

  upsert(id: string, patch: { name?: string; baseURL?: string; authHeader?: string }): ApiConnection {
    if (!API_CONNECTION_ID.test(id)) throw new AppError("VALIDATION_ERROR", "A connection id is lower-case letters, digits and dashes (up to 32).");
    const before = this.read()[id];
    const parsed = apiConnectionSchema.safeParse({
      name: patch.name ?? before?.name,
      baseURL: patch.baseURL ?? before?.baseURL,
      authHeader: patch.authHeader || before?.authHeader || undefined,
    });
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid connection");
    const clash = this.list().find((c) => c.id !== id && c.name.trim().toLowerCase() === parsed.data.name.trim().toLowerCase());
    if (clash) throw new AppError("VALIDATION_ERROR", `A connection named “${parsed.data.name}” already exists.`);
    const value = { name: parsed.data.name, baseURL: parsed.data.baseURL.replace(/\/+$/, ""), authHeader: parsed.data.authHeader };
    this.settings.setJson(STORE_KEY, { ...this.read(), [id]: value });
    return { id, ...value };
  }

  async setSecret(id: string, secret: string | null): Promise<void> {
    if (secret === null) this.keys.delete(apiSecretName(id));
    else await this.keys.set(apiSecretName(id), secret);
  }

  /** The secret, for the moment a request is sent. Never returned to a client or the model. */
  secret(id: string): Promise<string | null> {
    return this.keys.get(apiSecretName(id));
  }

  delete(id: string): boolean {
    const all = this.read();
    if (!(id in all)) return false;
    delete all[id];
    this.settings.setJson(STORE_KEY, all);
    this.keys.delete(apiSecretName(id));
    return true;
  }

  config(): HttpSettings {
    return { ...DEFAULT_HTTP_SETTINGS, ...(this.settings.getJson<Partial<HttpSettings>>(SETTINGS_KEY) ?? {}) };
  }

  setConfig(patch: Partial<HttpSettings>): HttpSettings {
    const next = { ...this.config(), ...patch };
    this.settings.setJson(SETTINGS_KEY, next);
    return next;
  }
}
