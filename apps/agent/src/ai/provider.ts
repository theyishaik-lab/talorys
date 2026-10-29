import { looksLikeContextOverflow } from "./overflow";
import type { AiAttempt, AiFailureReason, AiProviderId } from "@talorys/shared";
import type { z } from "zod";
import { AppError } from "../api/errors";

/** Human names of the providers, used in error messages (the UI localizes by code, not by this text). */
export const PROVIDER_NAMES: Record<AiProviderId, string> = { "workers-ai": "Cloudflare Workers AI", gemini: "Google Gemini", openrouter: "OpenRouter", "openai-compatible": "The OpenAI-compatible endpoint" };

export interface ModelMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateRequest {
  system: string;
  messages: ModelMessage[];
  maxOutputTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/** A tool as seen by a provider. Execution limits are enforced by the caller-supplied `execute`. */
export interface ProviderTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute: (input: unknown, callId: string) => Promise<unknown>;
}

export interface ToolRequest extends GenerateRequest {
  tools: ProviderTool[];
  /** Maximum model round-trips (each may contain several tool calls). */
  maxIterations: number;
  /** Returns true when no further tool calls are allowed; the model must then answer in text. */
  toolBudgetExhausted: () => boolean;
  /**
   * Called before every model call after the first; it records the call against the
   * daily budget and returns false when the budget is spent, which ends the turn.
   */
  reserveNextStep?: () => boolean;
}

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; name: string; output: unknown; error?: string }
  | { type: "usage"; usage: Usage }
  /** The turn switched to the backup model (quota or configuration failure on the chosen one). */
  | { type: "provider"; provider: AIProvider["id"]; model: string; attempts?: AiAttempt[] };

/**
 * Provider abstraction: Workers AI (built in), Google Gemini and OpenRouter (with a stored key)
 * all run through `AiSdkProvider`; the mock is for development and demo mode.
 */
export interface AIProvider {
  readonly id: AiProviderId | (string & {});
  /** The model id this provider answers with. */
  readonly modelId?: string;
  generate(req: GenerateRequest): Promise<{ text: string; usage: Usage }>;
  stream(req: GenerateRequest): AsyncIterable<AgentEvent>;
  generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent>;
  /**
   * The largest prompt (in `estimateTokens` units) this provider's model takes next to a reply of
   * `maxOutputTokens`; absent when unknown (the owner's maxContextTokens alone then applies).
   */
  promptBudget?(maxOutputTokens: number): number;
}

/** Rough token estimate (≈4 chars/token) used for budgeting and local usage estimates. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Maps provider failures onto stable application errors, with the provider in `details` so the
 * UI can say which quota ran out and offer Settings → Model.
 * Workers AI: 4006 = daily free allocation exhausted; 3040 / 429 = capacity or rate limits.
 * Gemini: 429 RESOURCE_EXHAUSTED = free-tier quota; 400/403 API_KEY_INVALID = bad key.
 * OpenRouter: 402 = out of credits; 429 = free-model rate limit; 401 = bad key.
 */
export function classifyAiError(error: unknown, provider: AiProviderId = "workers-ai", model?: string): AppError {
  if (error instanceof AppError) return error;
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const name = PROVIDER_NAMES[provider];
  const status = statusOf(error);
  const hints = quotaHints(error, provider);
  // Which model failed and why, for the UI's "Gemini 3.5 Flash (Google): overloaded 503" line.
  const why = (reason: AiFailureReason) => ({ provider, model, status, reason, ...hints });
  const details = why("error");
  if (lower.includes("abort")) {
    return new AppError("AI_UNAVAILABLE", "The response was cancelled.", details);
  }
  // The prompt is larger than this model's window: no pause for the model (it is healthy), and the
  // runner compacts the thread and retries once (src/agent/context.ts).
  if (looksLikeContextOverflow(rawErrorText(error), status)) {
    return new AppError("AI_UNAVAILABLE", `${name}: the conversation is longer than this model's context window.`, { ...details, context_overflow: true });
  }
  if (provider === "workers-ai") {
    if (lower.includes("4006") || lower.includes("free allocation") || lower.includes("neurons")) {
      return new AppError(
        "AI_QUOTA_EXHAUSTED",
        "Your Cloudflare account has used its Workers AI allocation for today. Tasks, notes, memories and reminders keep working; chat will resume when the quota resets, or switch to another model in Settings.",
        why("quota"),
      );
    }
    if (lower.includes("3040") || lower.includes("capacity") || lower.includes("429") || lower.includes("rate limit") || lower.includes("too many")) {
      return new AppError("AI_UNAVAILABLE", "Workers AI is busy right now. Please try again in a moment.", why("overloaded"));
    }
    // 5035: a model only the Workers Paid plan may call. Seen Oct 29, 2026 on every Workers AI model in
    // the chain (deepseek-v4.1-flash, kimi-k2.7-code, glm-5.3, glm-5.3-flash, kimi-k2.6): it used to
    // fall through as a generic error with a one-minute pause, so each turn retried all five first.
    if (lower.includes("5035") || lower.includes("not available on the workers free plan")) {
      return new AppError(
        "AI_UNAVAILABLE",
        `${model ?? "This Workers AI model"} needs the Cloudflare Workers Paid plan. Remove it from the model chain in Settings → Model, or upgrade the account.`,
        why("no_model"),
      );
    }
    if (lower.includes("5007") || lower.includes("no such model") || lower.includes("model not found")) {
      return new AppError("AI_UNAVAILABLE", "The configured AI model is not available. Choose another model in Settings.", why("no_model"));
    }
  } else {
    if (status === 401 || status === 403 || lower.includes("api_key_invalid") || lower.includes("api key not valid") || lower.includes("invalid api key") || lower.includes("no auth credentials")) {
      return new AppError("NOT_CONFIGURED", `${name} rejected the API key. Check it in Settings → Model.`, why("bad_key"));
    }
    if (status === 429 || status === 402 || lower.includes("resource_exhausted") || lower.includes("quota") || lower.includes("rate limit") || lower.includes("insufficient credits")) {
      return new AppError("AI_QUOTA_EXHAUSTED", `${name} has no quota left for this model right now (free-tier limit). Switch to another model in Settings, or wait a bit.`, why("quota"));
    }
    if (status === 404 || lower.includes("not found") || lower.includes("no such model") || lower.includes("is not found for api version")) {
      return new AppError("AI_UNAVAILABLE", `${name} does not offer the configured model. Choose another model in Settings.`, why("no_model"));
    }
    if (status !== null && status >= 500) {
      return new AppError("AI_UNAVAILABLE", `${name} is having trouble right now. Please try again in a moment.`, why("overloaded"));
    }
  }
  // The response body says why a bare "Bad Request" happened (Cohere 400s, Oct 26-28, 2026 were unreadable without it).
  const raw = rawErrorText(error);
  console.error(`${name} error`, message, raw.length > message.length ? raw.slice(message.length, message.length + 600).trim() : "");
  return new AppError("AI_UNAVAILABLE", "The AI model could not respond. Please try again.", details);
}

/**
 * What a provider said about when to come back, read from the raw error (AI SDK APICallError
 * keeps the response headers and body): the retry delay, whether a DAILY allowance is spent, and
 * whether the limit is the whole account's. Used to pause a model instead of retrying it on every
 * message (cooldown.ts). Samples, Oct 13, 2026:
 *  - Gemini 429: "Quota exceeded for metric: …free_tier_requests, limit: 0 … Please retry in 4h26m27.9s."
 *    with quotaId "GenerateRequestsPerDayPerProjectPerModel-FreeTier" (per model, per day) or
 *    "…PerMinute…"; also `"retryDelay": "37s"` in the body.
 *  - OpenRouter 429: "Rate limit exceeded: free-models-per-day" + X-RateLimit-Reset (epoch ms) —
 *    the 50 free requests/day are the account's, shared by every :free model.
 *  - Workers AI 4006: "you have used up your daily free allocation of 10,000 neurons" (account-wide).
 */
export function quotaHints(error: unknown, provider: AiProviderId): { retry_after_s?: number; quota_window?: "day" | "minute"; scope?: "model" | "provider" } {
  const text = rawErrorText(error);
  const lower = text.toLowerCase();
  const out: { retry_after_s?: number; quota_window?: "day" | "minute"; scope?: "model" | "provider" } = {};
  const headers = headersOf(error);
  const retryAfter = headers["retry-after"];
  if (retryAfter && /^\d+(\.\d+)?$/.test(retryAfter.trim())) out.retry_after_s = Math.ceil(Number(retryAfter));
  // IETF RateLimit-Reset (OVH and others): seconds until the window resets.
  const delta = Number(headers["ratelimit-reset"]);
  if (out.retry_after_s === undefined && Number.isFinite(delta) && delta > 0 && delta < 1e6) out.retry_after_s = Math.ceil(delta);
  const reset = Number(headers["x-ratelimit-reset"]);
  if (out.retry_after_s === undefined && Number.isFinite(reset) && reset > 0) {
    const ms = reset > 1e12 ? reset : reset * 1000;
    const s = Math.ceil((ms - Date.now()) / 1000);
    if (s > 0) out.retry_after_s = s;
  }
  if (out.retry_after_s === undefined) {
    const m = text.match(/retry in ((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i) ?? text.match(/"retryDelay"\s*:\s*"([\d.]+s)"/i);
    const s = m?.[1] ? durationSeconds(m[1]) : 0;
    if (s > 0) out.retry_after_s = s;
  }
  if (/per ?day|per-day|perday|daily|4006|free allocation|neurons/.test(lower)) out.quota_window = "day";
  else if (/per ?minute|per-min|perminute|rate-limited upstream|rate limit/.test(lower)) out.quota_window = "minute";
  if ((provider === "openrouter" && /free-models-per-(day|min)/.test(lower)) || (provider === "workers-ai" && /4006|free allocation|neurons/.test(lower))) {
    out.scope = "provider";
  }
  return out;
}

/** "4h26m27.9s" / "37s" / "2m" → seconds (rounded up). */
function durationSeconds(s: string): number {
  const h = Number(s.match(/(\d+)h/)?.[1] ?? 0);
  const m = Number(s.match(/(\d+)m(?!s)/)?.[1] ?? 0);
  const sec = Number(s.match(/([\d.]+)s/)?.[1] ?? 0);
  return Math.ceil(h * 3600 + m * 60 + sec);
}

/** The error's message chain plus any response body it carries. */
function rawErrorText(error: unknown): string {
  const parts: string[] = [errorMessage(error)];
  let e: unknown = error;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const body = (e as { responseBody?: unknown }).responseBody;
    if (typeof body === "string") parts.push(body.slice(0, 4000));
    e = (e as { cause?: unknown }).cause;
  }
  return parts.join(" ");
}

/** Lower-cased response headers from an AI SDK error (or its cause), when it kept them. */
function headersOf(error: unknown): Record<string, string> {
  let e: unknown = error;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const h = (e as { responseHeaders?: unknown }).responseHeaders;
    if (h && typeof h === "object") {
      return Object.fromEntries(Object.entries(h as Record<string, unknown>).map(([k, v]) => [k.toLowerCase(), String(v)]));
    }
    e = (e as { cause?: unknown }).cause;
  }
  return {};
}

/** The HTTP status an AI SDK / fetch error carries, when it carries one. */
function statusOf(error: unknown): number | null {
  let e: unknown = error;
  for (let i = 0; i < 4 && e && typeof e === "object"; i++) {
    const s = (e as { statusCode?: unknown; status?: unknown }).statusCode ?? (e as { status?: unknown }).status;
    if (typeof s === "number") return s;
    e = (e as { cause?: unknown }).cause;
  }
  const m = errorMessage(error).match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    return `${error.name}: ${error.message}${cause ? ` (${errorMessage(cause)})` : ""}`;
  }
  return String(error);
}
