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
  /** Function calling, when the model card says (informational). */
  tools?: boolean;
  /**
   * Thinking, when the model card says (informational): "always" cannot be turned off; "default"
   * is on unless the request disables it. Reasoning tokens count as output.
   */
  reasoning?: "always" | "default";
}

/**
 * Thinking models served by free/cheap hosts (NVIDIA build: DeepSeek V4.1 Flash and GLM-5.3 Flash only; OpenRouter). Read Oct 29, 2026:
 *  - DeepSeek V4.1 Flash: 1,048,576 combined context (build.nvidia.com/deepseek-ai/deepseek-v4.1-flash
 *    model card), 393,216 max output (Alibaba Model Studio / DeepSeek: 384K), tool calls, thinking on
 *    by default (api-docs.deepseek.com/guides/thinking_mode).
 *  - GLM-5.3 Flash: 1,048,576 context (build.nvidia.com/z-ai/glm-5-3-flash model card), 128K max
 *    output (docs.z.ai/guides/vlm/glm-5.3-flash), tool calls, thinking cannot be disabled.
 *  - Kimi K2.6 (NOT on NVIDIA build as of Oct 29, 2026; OpenRouter / Moonshot / other hosts): 262,144
 *    context (platform.kimi.ai/docs/guide/kimi-k2-6-quickstart); Moonshot gives no output maximum, only max_tokens default 32,768, used as the cap;
 *    tool calls (tool_choice "required" is rejected in thinking mode), thinking on by default.
 */
const THINKING_HOSTED: [RegExp, ModelCaps][] = [
  [/deepseek-v4\.1-flash/, { context: 1_048_576, maxOutput: 393_216, tools: true, reasoning: "default" }],
  [/glm-5\.3-flash/, { context: 1_048_576, maxOutput: 131_072, tools: true, reasoning: "always" }],
  [/kimi-k2\.6/, { context: 262_144, maxOutput: 32_768, tools: true, reasoning: "default" }],
];

const OPENROUTER: [RegExp, ModelCaps][] = [
  ...THINKING_HOSTED,
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
  ...THINKING_HOSTED,
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
