import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type AiEndpoint, aiEndpointSchema, ENDPOINT_ID, splitEndpointModel } from "@talorys/shared";
import type { LanguageModel } from "ai";
import { AppError } from "../api/errors";
import type { ProviderKeyStore } from "./keys";
import { AiSdkProvider } from "./workers-ai";

/**
 * Any OpenAI-compatible chat endpoint (OVH AI Endpoints, Groq, Cerebras, Mistral, GitHub Models,
 * NVIDIA …) as one more provider: an owner-registered base URL plus an optional key, so a new free
 * source joins the fallback chain with no new code. Model ids are "<endpoint id>/<model>".
 */
export const ENDPOINT_PRESETS: Record<string, { name: string; baseURL: string; keyless?: boolean }> = {
  // Anonymous use allowed (no key): 2 requests per minute per IP and model (checked Oct 13, 2026).
  ovh: { name: "OVH AI Endpoints", baseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", keyless: true },
  groq: { name: "Groq", baseURL: "https://api.groq.com/openai/v1" },
  cerebras: { name: "Cerebras", baseURL: "https://api.cerebras.ai/v1" },
  mistral: { name: "Mistral", baseURL: "https://api.mistral.ai/v1" },
  github: { name: "GitHub Models", baseURL: "https://models.github.ai/inference" },
  nvidia: { name: "NVIDIA", baseURL: "https://integrate.api.nvidia.com/v1" },
};

const STORE_KEY = "ai.endpoints";

export interface EndpointSettingsStore {
  getJson<T>(key: string): T | null;
  setJson(key: string, value: unknown): void;
}

/** The key name an endpoint's API key is stored under in ProviderKeyStore. */
export function endpointKeyName(id: string): `endpoint:${string}` {
  return `endpoint:${id}`;
}

/** The registered endpoints, in `tal_settings` (no secrets: keys live encrypted in ProviderKeyStore). */
export class EndpointStore {
  constructor(private readonly settings: EndpointSettingsStore) {}

  private read(): Record<string, Omit<AiEndpoint, "id">> {
    const v = this.settings.getJson<Record<string, Omit<AiEndpoint, "id">>>(STORE_KEY);
    return v && typeof v === "object" ? v : {};
  }

  list(): AiEndpoint[] {
    return Object.entries(this.read())
      .map(([id, e]) => ({ id, ...e }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): AiEndpoint | null {
    const e = this.read()[id];
    return e ? { id, ...e } : null;
  }

  /** Adds or changes an endpoint; a preset id fills in what is not given. */
  upsert(id: string, patch: { name?: string; baseURL?: string }): AiEndpoint {
    if (!ENDPOINT_ID.test(id)) throw new AppError("VALIDATION_ERROR", "An endpoint id is lower-case letters, digits and dashes (up to 32).");
    const before = this.read()[id];
    const preset = ENDPOINT_PRESETS[id];
    const merged = { name: patch.name ?? before?.name ?? preset?.name ?? id, baseURL: patch.baseURL ?? before?.baseURL ?? preset?.baseURL ?? "" };
    const parsed = aiEndpointSchema.safeParse(merged);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid endpoint");
    const value = { name: parsed.data.name, baseURL: parsed.data.baseURL.replace(/\/+$/, "") };
    this.settings.setJson(STORE_KEY, { ...this.read(), [id]: value });
    return { id, ...value };
  }

  delete(id: string): boolean {
    const all = this.read();
    if (!(id in all)) return false;
    delete all[id];
    this.settings.setJson(STORE_KEY, all);
    return true;
  }
}

/** A model on a registered endpoint; NOT_CONFIGURED (so the chain moves on) when the endpoint is gone. */
export class OpenAICompatibleProvider extends AiSdkProvider {
  constructor(modelId: string, endpoints: EndpointStore, keys: Pick<ProviderKeyStore, "get">) {
    super("openai-compatible", modelId, async () => {
      const ref = splitEndpointModel(modelId);
      const endpoint = ref ? endpoints.get(ref.endpoint) : null;
      if (!ref || !endpoint) {
        throw new AppError("NOT_CONFIGURED", `No endpoint "${ref?.endpoint ?? modelId}" is registered. Add it in Settings → Model.`, {
          provider: "openai-compatible",
          model: modelId,
          reason: "not_configured",
        });
      }
      const key = await keys.get(endpointKeyName(endpoint.id));
      const provider = createOpenAICompatible({ name: endpoint.id, baseURL: endpoint.baseURL, ...(key ? { apiKey: key } : {}) });
      return provider.chatModel(ref.model) as LanguageModel;
    });
  }
}
