import { type AiAttribution, type ApiErrorCode, formatAttempts, modelDisplayName } from "@talorys/shared";
import type { Locale, StringKey } from "./i18n";

type T = (key: StringKey, vars?: Record<string, string | number>) => string;

/**
 * What the chat's error bubble says: a headline in the owner's language, and — when the agent sent
 * the attribution — a second line naming each model tried and why
 * ("Gemini 3.8 Flash (Google): עומס 503 · Gemini 3.5 Flash Lite (Google): עומס 503").
 * Older agents send no attribution: the headline is then what it always was.
 */
export function chatErrorView(input: {
  error: string;
  errorCode?: ApiErrorCode | null;
  ai?: AiAttribution | null;
  /** The failing provider's display name (for the quota / not-set-up lines). */
  providerName: string;
  locale: Locale;
  t: T;
}): { headline: string; tried: string | null; offerSettings: boolean } {
  const { error, errorCode, ai, providerName, locale, t } = input;
  const attempts = ai?.attempts ?? [];
  const tried = attempts.length > 0 ? formatAttempts(attempts, locale) : null;
  const headline =
    attempts.length > 1
      ? t("chat.error.allFailed")
      : errorCode === "AI_QUOTA_EXHAUSTED"
        ? t("chat.error.AI_QUOTA_EXHAUSTED", { provider: providerName })
        : errorCode === "NOT_CONFIGURED"
          ? t("chat.error.NOT_CONFIGURED", { provider: providerName, message: attempts[0] ? modelDisplayName(attempts[0]) : error })
          : errorCode === "AI_LIMIT_REACHED"
            ? t("chat.error.AI_LIMIT_REACHED")
            : errorCode === "AI_UNAVAILABLE" && tried
              ? t("chat.error.AI_UNAVAILABLE")
              : error;
  const offerSettings = errorCode === "AI_QUOTA_EXHAUSTED" || errorCode === "NOT_CONFIGURED" || errorCode === "AI_LIMIT_REACHED" || attempts.length > 1;
  return { headline, tried, offerSettings };
}

/** The quiet note under a reply a backup wrote: "ענה: Nemotron 3 Super 120B A12B (OpenRouter)". Null when the chosen model answered. */
export function answeredByView(ai: AiAttribution | null | undefined, hasError: boolean, locale: Locale, t: T): { text: string; title: string | undefined } | null {
  if (hasError || !ai?.fallback) return null;
  return {
    text: t("chat.answeredBy", { model: modelDisplayName(ai) }),
    title: ai.attempts.length ? t("chat.answeredByTitle", { attempts: formatAttempts(ai.attempts, locale) }) : undefined,
  };
}
