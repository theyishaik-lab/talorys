import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { AppError } from "../api/errors";
import { AiSdkProvider } from "./workers-ai";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/** OpenRouter: OpenAI-compatible chat completions with tool calling and streaming. */
export class OpenRouterProvider extends AiSdkProvider {
  constructor(modelId: string, apiKey: () => Promise<string | null>, appUrl?: string) {
    super("openrouter", modelId, async () => {
      const key = await apiKey();
      if (!key) throw new AppError("NOT_CONFIGURED", "OpenRouter needs an API key. Add one in Settings → Model.", { provider: "openrouter", model: modelId, reason: "not_configured" });
      const provider = createOpenAICompatible({
        name: "openrouter",
        baseURL: OPENROUTER_BASE_URL,
        apiKey: key,
        headers: { "HTTP-Referer": appUrl ?? "https://github.com/rociiu/talorys", "X-Title": "Talorys" },
      });
      return provider.chatModel(modelId) as LanguageModel;
    });
  }
}

export interface OpenRouterModel {
  id: string;
  name: string;
  description: string;
  context: number | null;
  tools: boolean;
  free: boolean;
  price: { input: number; output: number } | null;
}

/** The public model list (no key needed). `freeOnly` keeps the `:free` models, which the free account can use. */
export async function listOpenRouterModels(opts: { apiKey?: string | null; freeOnly?: boolean; signal?: AbortSignal } = {}): Promise<OpenRouterModel[]> {
  const r = await fetch(`${OPENROUTER_BASE_URL}/models`, { headers: opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}, signal: opts.signal });
  if (!r.ok) throw new Error(`OpenRouter answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = (await r.json()) as { data?: { id: string; name?: string; description?: string; context_length?: number; supported_parameters?: string[]; pricing?: { prompt?: string; completion?: string } }[] };
  return (body.data ?? [])
    .map((m) => {
      const input = Number(m.pricing?.prompt ?? NaN) * 1_000_000;
      const output = Number(m.pricing?.completion ?? NaN) * 1_000_000;
      const free = m.id.endsWith(":free") || (input === 0 && output === 0);
      return {
        id: m.id,
        name: (m.name ?? m.id).replace(/\s*\(free\)$/i, ""),
        description: ((m.description ?? "").split(/\n/)[0] ?? "").slice(0, 200),
        context: m.context_length ?? null,
        tools: (m.supported_parameters ?? []).includes("tools"),
        free,
        price: Number.isFinite(input) && Number.isFinite(output) && !free ? { input: round(input), output: round(output) } : null,
      };
    })
    .filter((m) => (opts.freeOnly ?? true ? m.free : true));
}

/** Verifies a key with the account endpoint (costs nothing). */
export async function checkOpenRouterKey(apiKey: string, signal?: AbortSignal): Promise<{ label: string | null; limit_remaining: number | null }> {
  const r = await fetch(`${OPENROUTER_BASE_URL}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal });
  if (r.status === 401 || r.status === 403) throw new Error("OpenRouter rejected the key");
  if (!r.ok) throw new Error(`OpenRouter answered ${r.status}`);
  const body = (await r.json()) as { data?: { label?: string; limit_remaining?: number | null } };
  return { label: body.data?.label ?? null, limit_remaining: body.data?.limit_remaining ?? null };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
