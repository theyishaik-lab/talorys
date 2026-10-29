import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type AiEndpoint, aiEndpointSchema, ENDPOINT_ID, splitEndpointModel } from "@talorys/shared";
import type { LanguageModel } from "ai";
import { AppError } from "../api/errors";
import type { ProviderKeyStore } from "./keys";
import { observingFetch, type QuotaSnapshot, requestsWindowFor } from "./quota";
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
  /** `onQuota` receives the rate-limit headers of each response (quota.ts), for Settings → Model. */
  constructor(modelId: string, endpoints: EndpointStore, keys: Pick<ProviderKeyStore, "get">, onQuota?: (snapshot: QuotaSnapshot) => void) {
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
      const plain = ((i, init) => fetch(i, init)) as typeof fetch;
      const base = keepsReasoningContent(endpoint.baseURL) ? plain : withoutReasoningContent(plain);
      const provider = createOpenAICompatible({
        name: endpoint.id,
        baseURL: endpoint.baseURL,
        ...(key ? { apiKey: key } : {}),
        fetch: onQuota ? observingFetch(onQuota, { requestsWindow: requestsWindowFor(endpoint.baseURL), base }) : base,
      });
      return provider.chatModel(ref.model) as LanguageModel;
    });
  }
}

/**
 * Endpoints whose thinking models need their reasoning sent back with tool calls (DeepSeek and
 * Moonshot document `reasoning_content` on assistant messages). Every other endpoint gets it removed.
 */
export function keepsReasoningContent(baseURL: string): boolean {
  return /(^|[./])(deepseek\.com|moonshot\.(ai|cn))(\/|:|$)/.test(baseURL.replace(/^https?:\/\//, ""));
}

/**
 * The AI SDK echoes a model's reasoning back as `reasoning_content` on the assistant message of the
 * next tool step. Groq rejects that field outright ("'messages.2' : for 'role:assistant' … property
 * 'reasoning_content' is unsupported"), which failed 176 scheduled runs on Qwen3.8 27B (Groq),
 * Oct 22-25, 2026, at the second step of every tool loop. This drops the field from outgoing
 * assistant messages; the reasoning is not needed to continue.
 */
export function withoutReasoningContent(base: typeof fetch): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (init && typeof init.body === "string" && init.body.includes('"reasoning_content"')) {
      try {
        const body = JSON.parse(init.body) as { messages?: Record<string, unknown>[] };
        if (Array.isArray(body.messages)) {
          for (const m of body.messages) if (m && m.role === "assistant" && "reasoning_content" in m) delete m.reasoning_content;
          init = { ...init, body: JSON.stringify(body) };
        }
      } catch {
        /* not JSON: send as is */
      }
    }
    return base(input, init);
  };
  return wrapped as typeof fetch;
}
