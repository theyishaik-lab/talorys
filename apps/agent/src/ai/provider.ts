import type { AiAttempt, AiFailureReason, AiProviderId } from "@talorys/shared";
import type { z } from "zod";
import { AppError } from "../api/errors";

/** Human names of the providers, used in error messages (the UI localizes by code, not by this text). */
export const PROVIDER_NAMES: Record<AiProviderId, string> = { "workers-ai": "Cloudflare Workers AI", gemini: "Google Gemini", openrouter: "OpenRouter" };

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
  // Which model failed and why, for the UI's "Gemini 3.5 Flash (Google): overloaded 503" line.
  const why = (reason: AiFailureReason) => ({ provider, model, status, reason });
  const details = why("error");
  if (lower.includes("abort")) {
    return new AppError("AI_UNAVAILABLE", "The response was cancelled.", details);
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
  console.error(`${name} error`, message);
  return new AppError("AI_UNAVAILABLE", "The AI model could not respond. Please try again.", details);
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
