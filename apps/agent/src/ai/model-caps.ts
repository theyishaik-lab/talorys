import type { AiProviderId } from "@talorys/shared";

/**
 * What one model takes: its context window and the most output tokens it may be asked for. The
 * owner's limits (Settings → AI) may be far above either; a request is clamped to the model it
 * goes to, so a high limit never makes a smaller model refuse the call.
 *
 * Sources, read Oct 13, 2026: Gemini's models API (inputTokenLimit / outputTokenLimit), OpenRouter's
 * /api/v1/models (context_length, top_provider.max_completion_tokens), Cloudflare's model catalog
 * (context_window; Workers AI publishes no output maximum, so a quarter of the window is used).
 */
export interface ModelCaps {
  context: number;
  maxOutput: number;
}

const OPENROUTER: [RegExp, ModelCaps][] = [
  [/nemotron-3-ultra/, { context: 1_000_000, maxOutput: 65_536 }],
  [/nemotron-3-super/, { context: 262_144, maxOutput: 65_536 }],
  [/nemotron-3\.5-lightning/, { context: 1_000_000, maxOutput: 65_536 }],
  [/nemotron-3-nano/, { context: 256_000, maxOutput: 65_536 }],
  [/gemma-4/, { context: 262_144, maxOutput: 32_768 }],
  [/laguna/, { context: 262_144, maxOutput: 32_768 }],
  [/dots-3/, { context: 512_000, maxOutput: 65_536 }],
  [/inkling/, { context: 1_048_576, maxOutput: 65_536 }],
];

const WORKERS_AI: [RegExp, ModelCaps][] = [
  [/gemma-4/, { context: 256_000, maxOutput: 32_768 }],
  [/gpt-oss-120b|gpt-oss-20b/, { context: 128_000, maxOutput: 32_000 }],
  [/glm-4\.7/, { context: 131_072, maxOutput: 32_768 }],
];

/** Models on OpenAI-compatible endpoints (OVH's /v1/models lists context = max completion). */
const ENDPOINT_MODELS: [RegExp, ModelCaps][] = [
  [/qwen3\.5-397b|qwen3\.[5-9]-|qwen3-/, { context: 262_144, maxOutput: 32_768 }],
  [/gpt-oss-(120|20)b/, { context: 131_072, maxOutput: 32_768 }],
  [/llama-3[._]3-70b|mistral-small|mistral-nemo/, { context: 131_072, maxOutput: 16_384 }],
];

/** The caps of a (provider, model) pair; unknown models get a conservative default. */
export function modelCaps(provider: AiProviderId | string, model: string): ModelCaps {
  const id = model.toLowerCase();
  if (provider === "gemini") {
    if (/^gemma-/.test(id)) return { context: 262_144, maxOutput: 32_768 };
    return { context: 1_048_576, maxOutput: 65_536 };
  }
  const table = provider === "openrouter" ? OPENROUTER : provider === "workers-ai" ? WORKERS_AI : provider === "openai-compatible" ? ENDPOINT_MODELS : [];
  for (const [re, caps] of table) if (re.test(id)) return caps;
  return provider === "openrouter" || provider === "openai-compatible" ? { context: 131_072, maxOutput: 16_384 } : { context: 32_768, maxOutput: 4_096 };
}

/**
 * Talorys estimates tokens as characters / 4 (`estimateTokens`). Hebrew runs about twice that
 * many tokens per character, so the history is given at most this share of the window left after
 * the reply, keeping a long Hebrew conversation inside the model's real window.
 */
export const PROMPT_SHARE = 0.5;

/** The output tokens a request to this model may ask for. */
export function outputFor(caps: ModelCaps, requested: number): number {
  return Math.max(1, Math.min(requested, caps.maxOutput));
}

/** The prompt (estimated tokens) that fits this model next to a reply of the requested size. */
export function promptBudgetFor(caps: ModelCaps, requestedOutput: number): number {
  return Math.floor((caps.context - outputFor(caps, requestedOutput)) * PROMPT_SHARE);
}
