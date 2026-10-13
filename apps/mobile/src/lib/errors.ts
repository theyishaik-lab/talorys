import { type AiAttribution, formatAttempts, modelDisplayName } from "@talorys/shared";
import type { StringKey } from "./i18n";

/**
 * Maps what went wrong in a chat turn (an error code, the agent's English message, or the phone's
 * own network exception text such as "Software caused connection abort") to a friendly string.
 * Unknown errors return null and are shown as they are.
 */
export function chatErrorKey(codeOrText: string | null | undefined): StringKey | null {
  if (!codeOrText) return null;
  const s = codeOrText;
  if (/^CONFLICT$|already being generated/i.test(s)) return "chat.err.busy";
  if (/^AI_LIMIT_REACHED$|daily limit of \d+ AI requests/i.test(s)) return "chat.err.dailyLimit";
  if (/^AI_QUOTA_EXHAUSTED$|quota|allowance|neurons/i.test(s)) return "chat.err.quota";
  if (/^AI_UNAVAILABLE$|having trouble|could not respond|no answer from|temporarily unavailable|high demand/i.test(s)) return "chat.err.unavailable";
  if (/^UNAUTHORIZED$|sign in again|not signed in/i.test(s)) return "chat.err.unauthorized";
  if (/^NETWORK$|connection abort|connection reset|socket|network|timeout|timed out|unexpected end of stream|stream was reset|failed to connect|unable to resolve|connection lost|closed/i.test(s)) return "chat.err.network";
  if (/^INTERNAL_ERROR$|something went wrong/i.test(s)) return "chat.err.generic";
  return null;
}

/** The error text to show: the friendly translation when the error is recognised, else the original. */
export function friendlyChatError(codeOrText: string, t: (key: StringKey) => string): string {
  const key = chatErrorKey(codeOrText);
  return key ? t(key) : codeOrText;
}

/**
 * The error bubble's two lines: the friendly headline, and — when the agent sent the attribution
 * (agent 0.1.13+) — which model(s) failed and why: "Gemini 3.8 Flash (Google): עומס 503 · …".
 */
export function chatErrorLines(
  input: { error: string; code?: string | null; ai?: AiAttribution | null },
  t: (key: StringKey) => string,
  locale: "en" | "he",
): { headline: string; tried: string | null } {
  const attempts = input.ai?.attempts ?? [];
  const key = attempts.length > 1 ? "chat.err.allFailed" : (input.code ? chatErrorKey(input.code) : null) ?? chatErrorKey(input.error);
  return { headline: key ? t(key) : input.error, tried: attempts.length ? formatAttempts(attempts, locale) : null };
}

/** The quiet note under a reply a backup wrote ("ענה: Nemotron 3 Super 120B A12B (OpenRouter)"); null when the chosen model answered. */
export function answeredByLine(ai: AiAttribution | null | undefined, hasError: boolean, t: (key: StringKey, vars?: Record<string, string | number>) => string): string | null {
  if (hasError || !ai?.fallback) return null;
  return t("chat.answeredBy", { model: modelDisplayName(ai) });
}
