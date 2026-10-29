import { type AiAttempt, type AiAttribution, type AiFailureReason, formatAttempts, modelDisplayName } from "@talorys/shared";
import { AppError } from "../api/errors";

/** What an AI error's `details` carry (all optional: other code paths throw plain AppErrors). */
export interface AiErrorDetails {
  provider?: string;
  model?: string;
  status?: number | null;
  reason?: AiFailureReason;
  timeout_s?: number;
  /** "first_byte" when the endpoint's own first-byte timeout cut the request (a short pause follows). */
  timeout_kind?: "first_byte" | "watchdog";
  attempts?: AiAttempt[];
  /** The provider's own "try again in" hint, in seconds (Retry-After, X-RateLimit-Reset, Gemini's "retry in 4h26m"). */
  retry_after_s?: number;
  /** "day" when a daily allowance is spent (it will not come back within minutes). */
  quota_window?: "day" | "minute";
  /** "provider" when the limit is the whole account's, not this model's (OpenRouter's free requests/day, Workers AI neurons). */
  scope?: "model" | "provider";
}

/** The failure that ended the turn: the last attempt that actually ran (skipped ones never ran). */
function lastTried(attempts: readonly AiAttempt[]): AiAttempt | undefined {
  return [...attempts].reverse().find((a) => !a.skipped) ?? attempts.at(-1);
}

export function detailsOf(error: unknown): AiErrorDetails {
  const d = error instanceof AppError ? error.details : undefined;
  return d && typeof d === "object" ? (d as AiErrorDetails) : {};
}

/** The reason word for an error, from what the classifier recorded or else from its code and text. */
export function reasonOf(error: unknown): AiFailureReason {
  const d = detailsOf(error);
  if (d.reason) return d.reason;
  if (!(error instanceof AppError)) return "error";
  const text = error.message.toLowerCase();
  if (error.code === "NOT_CONFIGURED") return /reject|invalid/.test(text) ? "bad_key" : "not_configured";
  if (error.code === "AI_QUOTA_EXHAUSTED") return "quota";
  if (error.code === "AI_UNAVAILABLE") {
    if (/no answer from .* within/.test(text)) return "timeout";
    if (/does not offer|not available\. choose/.test(text)) return "no_model";
    if (/busy|trouble|high demand|overload|capacity/.test(text) || (typeof d.status === "number" && d.status >= 500)) return "overloaded";
  }
  return "error";
}

/** One failed attempt, attributed to the candidate that ran it (the candidate is authoritative). */
export function attemptOf(error: unknown, provider: string, model: string): AiAttempt {
  const d = detailsOf(error);
  const code = error instanceof AppError ? error.code : "AI_UNAVAILABLE";
  const message = error instanceof Error ? error.message : String(error);
  const attempt: AiAttempt = { provider, model, code, reason: reasonOf(error), status: typeof d.status === "number" ? d.status : null, error: message.slice(0, 300) };
  if (typeof d.timeout_s === "number") attempt.timeout_s = d.timeout_s;
  return attempt;
}

/**
 * The turn's error once every model it tried has failed (or the one that had started answering
 * failed): the last failure's code, a message naming each model and why, and the attribution in
 * `details` — `provider`/`model` kept there too, which older web clients read.
 */
export function chainError(last: unknown, attempts: AiAttempt[]): AppError {
  const final = lastTried(attempts);
  const code = last instanceof AppError ? last.code : (final?.code ?? "AI_UNAVAILABLE");
  const original = last instanceof Error ? last.message : String(last);
  const message =
    attempts.length > 1
      ? `None of the models answered: ${formatAttempts(attempts, "en")}.`
      : final
        ? `${modelDisplayName(final)}: ${original}`
        : original;
  const details: AiErrorDetails = {
    provider: final?.provider,
    model: final?.model,
    status: final?.status ?? null,
    reason: final?.reason,
    attempts,
  };
  return new AppError(code, message, details, last instanceof AppError ? last.headers : undefined);
}

/** The attribution to save on a failed reply, from the turn's error. */
export function attributionFromError(error: unknown, fallback: { provider: string; model: string }, before: AiAttempt[] = []): AiAttribution {
  const d = detailsOf(error);
  if (Array.isArray(d.attempts) && d.attempts.length > 0) {
    const last = lastTried(d.attempts) as AiAttempt;
    return { provider: last.provider, model: last.model, fallback: d.attempts.length > 1 || before.length > 0, attempts: d.attempts };
  }
  const provider = d.provider ?? fallback.provider;
  const model = d.model ?? fallback.model;
  const attempts = [...before, attemptOf(error, provider, model)];
  return { provider, model, fallback: before.length > 0, attempts };
}
