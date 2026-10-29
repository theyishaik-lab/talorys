import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { type AiEndpoint, aiEndpointSchema, ENDPOINT_ID, splitEndpointModel } from "@talorys/shared";
import type { LanguageModel } from "ai";
import { AppError } from "../api/errors";
import type { ProviderKeyStore } from "./keys";
import { observingFetch, type QuotaSnapshot, requestsWindowFor } from "./quota";
import { AiSdkProvider } from "./workers-ai";

/**
 * Any OpenAI-compatible chat endpoint (OVH AI Endpoints, Groq, Cerebras, Mistral,
 * NVIDIA …) as one more provider: an owner-registered base URL plus an optional key, so a new free
 * source joins the fallback chain with no new code. Model ids are "<endpoint id>/<model>".
 */
export interface EndpointPreset {
  name: string;
  baseURL: string;
  keyless?: boolean;
  /** The service is gone: the preset is hidden from the API's list and fills nothing in. */
  deprecated?: string;
}

export const ENDPOINT_PRESETS: Record<string, EndpointPreset> = {
  // Anonymous use allowed (no key): 2 requests per minute per IP and model (checked Oct 13, 2026).
  ovh: { name: "OVH AI Endpoints", baseURL: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", keyless: true },
  groq: { name: "Groq", baseURL: "https://api.groq.com/openai/v1" },
  cerebras: { name: "Cerebras", baseURL: "https://api.cerebras.ai/v1" },
  mistral: { name: "Mistral", baseURL: "https://api.mistral.ai/v1" },
  // Retired 2026-07-30 (catalog, inference API and BYOK all off): https://github.blog/changelog/2026-07-30-github-models-is-now-retired
  github: { name: "GitHub Models", baseURL: "https://models.github.ai/inference", deprecated: "GitHub Models was retired on 2026-07-30." },
  // NVIDIA build (NIM trial): free, Bearer key from build.nvidia.com ("nvapi-…"); model ids are "<org>/<model>", e.g. "deepseek-ai/deepseek-v4.1-flash".
  nvidia: { name: "NVIDIA", baseURL: "https://integrate.api.nvidia.com/v1" },
};

/** The presets still offered (deprecated ones left out), for GET /api/ai/endpoints. */
export function visiblePresets(): Record<string, EndpointPreset> {
  return Object.fromEntries(Object.entries(ENDPOINT_PRESETS).filter(([, p]) => !p.deprecated));
}

const hostOf = (baseURL: string) => baseURL.replace(/^https?:\/\//, "").split(/[/:]/)[0]?.toLowerCase() ?? "";

/** Why an endpoint can no longer answer (its service was shut down), else null. */
export function retiredEndpoint(baseURL: string): string | null {
  return hostOf(baseURL) === "models.github.ai" ? (ENDPOINT_PRESETS.github?.deprecated ?? "Retired.") : null;
}

/**
 * Seconds before a silent request to this endpoint is cut off (0 = no limit): the endpoint's own
 * setting, else 20 s for NVIDIA build, whose free DeepSeek V4.1 Flash / GLM-5.3 Flash requests
 * were reported in Sep-Oct 2026 to hang for minutes without sending a byte.
 */
export function firstByteTimeoutSFor(endpoint: { baseURL: string; firstByteTimeoutS?: number }): number {
  if (typeof endpoint.firstByteTimeoutS === "number") return endpoint.firstByteTimeoutS;
  return hostOf(endpoint.baseURL) === "integrate.api.nvidia.com" ? NVIDIA_FIRST_BYTE_TIMEOUT_S : 0;
}
export const NVIDIA_FIRST_BYTE_TIMEOUT_S = 20;

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
  upsert(id: string, patch: { name?: string; baseURL?: string; firstByteTimeoutS?: number | null }): AiEndpoint {
    if (!ENDPOINT_ID.test(id)) throw new AppError("VALIDATION_ERROR", "An endpoint id is lower-case letters, digits and dashes (up to 32).");
    const before = this.read()[id];
    const found = ENDPOINT_PRESETS[id];
    const preset = found && !found.deprecated ? found : undefined;
    const timeout = patch.firstByteTimeoutS === null ? undefined : (patch.firstByteTimeoutS ?? before?.firstByteTimeoutS);
    const merged = {
      name: patch.name ?? before?.name ?? preset?.name ?? id,
      baseURL: patch.baseURL ?? before?.baseURL ?? preset?.baseURL ?? "",
      ...(timeout !== undefined ? { firstByteTimeoutS: timeout } : {}),
    };
    const parsed = aiEndpointSchema.safeParse(merged);
    if (!parsed.success) throw new AppError("VALIDATION_ERROR", parsed.error.issues[0]?.message ?? "Invalid endpoint");
    const retired = retiredEndpoint(parsed.data.baseURL);
    if (retired) throw new AppError("VALIDATION_ERROR", retired);
    const value = {
      name: parsed.data.name,
      baseURL: parsed.data.baseURL.replace(/\/+$/, ""),
      ...(parsed.data.firstByteTimeoutS !== undefined ? { firstByteTimeoutS: parsed.data.firstByteTimeoutS } : {}),
    };
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
      const retired = retiredEndpoint(endpoint.baseURL);
      if (retired) {
        // No request: the service is gone, so the model is paused for hours, not retried each turn.
        throw new AppError("AI_UNAVAILABLE", `${retired} Remove "${endpoint.name}" from the model chain in Settings → Model.`, {
          provider: "openai-compatible",
          model: modelId,
          reason: "no_model",
        });
      }
      const key = await keys.get(endpointKeyName(endpoint.id));
      const timeoutS = firstByteTimeoutSFor(endpoint);
      const plain = ((i, init) => fetch(i, init)) as typeof fetch;
      // Each network call (a reasoning retry included) gets its own first-byte timer.
      const timed = timeoutS > 0 ? withFirstByteTimeout(plain, timeoutS * 1000) : plain;
      const base = keepsReasoningContent(endpoint.baseURL) ? timed : withoutReasoningContent(timed);
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
 *
 * The opposite rule exists too: DeepSeek's own API answers 400 when a thinking-mode tool loop
 * omits `reasoning_content` (api-docs.deepseek.com/guides/thinking_mode). Hosts of DeepSeek
 * V4.1 Flash other than deepseek.com (NVIDIA build, OpenRouter, DeepInfra…) may or may not enforce
 * it, so when a stripped request is refused with a 400 that names the reasoning, it is sent once
 * more as the SDK wrote it, and that endpoint + model keeps its reasoning from then on (for the
 * life of the isolate).
 */
export function withoutReasoningContent(base: typeof fetch): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (!init || typeof init.body !== "string" || !init.body.includes('"reasoning_content"')) return base(input, init);
    const original = init;
    let stripped: typeof init | null = null;
    let model = "";
    try {
      const body = JSON.parse(init.body) as { model?: unknown; messages?: Record<string, unknown>[] };
      model = typeof body.model === "string" ? body.model : "";
      if (Array.isArray(body.messages)) {
        for (const m of body.messages) if (m && m.role === "assistant" && "reasoning_content" in m) delete m.reasoning_content;
        stripped = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      /* not JSON: send as is */
    }
    const key = `${urlOf(input)}\u0000${model}`;
    if (!stripped || NEEDS_REASONING.has(key)) return base(input, original);
    const res = await base(input, stripped);
    if (res.status !== 400) return res;
    const text = await res
      .clone()
      .text()
      .catch(() => "");
    if (!/reasoning/i.test(text) || /unsupported|not supported|unknown|not allowed|extra (inputs|fields)/i.test(text)) return res;
    NEEDS_REASONING.add(key);
    return base(input, original);
  };
  return wrapped as typeof fetch;
}

/** Endpoint + model pairs that refused a request without `reasoning_content` (see above). */
const NEEDS_REASONING = new Set<string>();

const urlOf = (input: Parameters<typeof fetch>[0]) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

/** A request cut off because the endpoint sent nothing within its first-byte timeout. */
export class FirstByteTimeoutError extends Error {
  override readonly name = "FirstByteTimeoutError";
  constructor(readonly timeoutMs: number) {
    super(`No first byte within ${Math.round(timeoutMs / 1000)} s`);
  }
}

/**
 * Cuts a request off when neither the response headers nor the first byte of its body arrive
 * within `ms` (connect + time to first byte), so a hanging endpoint fails fast with
 * `FirstByteTimeoutError` and the fallback chain moves on. Once the first byte is in, the
 * response streams with no limit.
 */
export function withFirstByteTimeout(base: typeof fetch, ms: number): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const controller = new AbortController();
    const outer = init?.signal ?? undefined;
    const onAbort = () => controller.abort(outer?.reason);
    if (outer?.aborted) controller.abort(outer.reason);
    else outer?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
    };
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new FirstByteTimeoutError(ms);
        reject(error);
        controller.abort(error);
      }, ms);
    });
    timeout.catch(() => {});
    const cleanup = () => {
      stop();
      outer?.removeEventListener("abort", onAbort);
    };
    let res: Response;
    try {
      res = await Promise.race([base(input, { ...init, signal: controller.signal }), timeout]);
    } catch (error) {
      cleanup();
      throw timedOut ? new FirstByteTimeoutError(ms) : error;
    }
    if (!res.body) {
      cleanup();
      return res;
    }
    const reader = res.body.getReader();
    let first = true;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        try {
          const r = first ? await Promise.race([reader.read(), timeout]) : await reader.read();
          if (first) {
            first = false;
            stop();
          }
          if (r.done) {
            cleanup();
            c.close();
          } else c.enqueue(r.value);
        } catch (error) {
          cleanup();
          c.error(timedOut ? new FirstByteTimeoutError(ms) : error);
        }
      },
      cancel(reason) {
        cleanup();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return wrapped as typeof fetch;
}
