import type { ApiErrorCode } from "./schemas";

/**
 * Which model answered a chat turn, and which ones failed on the way (the fallback chain). Carried
 * on the chat stream's `error` and `model` events and on the saved assistant message, so every
 * client can say "Gemini 3.5 Flash (Google): overloaded 503" instead of a bare "the model failed".
 * All fields are optional on the wire: older agents send none of them and older clients ignore them.
 */

/** Why one model in the chain did not answer, in a word a person understands. */
export type AiFailureReason =
  | "overloaded" // 5xx / "high demand" / Workers AI capacity
  | "quota" // free-tier quota or rate limit (429, 402, RESOURCE_EXHAUSTED, Workers AI 4006)
  | "timeout" // silent past the first-word watchdog
  | "not_configured" // no API key stored
  | "bad_key" // the provider rejected the key (401/403)
  | "no_model" // the provider does not offer the model (404)
  | "error"; // anything else

export interface AiAttempt {
  /** "gemini" | "openrouter" | "workers-ai" (a string for forward compatibility). */
  provider: string;
  /** The model id as configured, e.g. "gemini-3.5-flash". */
  model: string;
  /** The application error code this attempt failed with. */
  code: ApiErrorCode;
  reason: AiFailureReason;
  /** HTTP status from the provider when it sent one (503, 429, …). */
  status?: number | null;
  /** Seconds of silence before the watchdog moved on (reason "timeout"). */
  timeout_s?: number;
  /** The agent's English message for this attempt (short; for logs and tooltips). */
  error: string;
  /**
   * True when the model was not called this turn: it failed recently (`reason`) and is paused
   * until `until` (ISO time) so the turn did not wait on it again. Absent on older agents.
   */
  skipped?: boolean;
  until?: string;
}

/** Stored on an assistant message: who answered it (or whose failure ended it) and who failed before. */
export interface AiAttribution {
  /** The model that wrote the reply; for a failed reply, the last model tried. */
  provider: string;
  model: string;
  /** True when a backup answered instead of the chosen model. */
  fallback: boolean;
  /** Every model that failed in this turn, in the order tried (empty when the chosen model answered). */
  attempts: AiAttempt[];
}

/** Short provider names for chips and error lines. */
export const PROVIDER_SHORT_NAMES: Record<string, string> = { gemini: "Google", openrouter: "OpenRouter", "workers-ai": "Workers AI", "openai-compatible": "API" };

/** How well-known OpenAI-compatible endpoints are named ("ovh/gpt-oss-120b" → "OVH"). */
const ENDPOINT_NAMES: Record<string, string> = { ovh: "OVH", groq: "Groq", cerebras: "Cerebras", mistral: "Mistral", github: "GitHub Models", nvidia: "NVIDIA", together: "Together", sambanova: "SambaNova", zai: "Z.ai", cohere: "Cohere" };

/** The endpoint's display name from an "<endpoint>/<model>" id. */
export function endpointShortName(model: string | null | undefined): string {
  const id = (model ?? "").split("/")[0] ?? "";
  if (!id) return "";
  return ENDPOINT_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

export function providerShortName(provider: string | null | undefined): string {
  if (!provider) return "";
  return PROVIDER_SHORT_NAMES[provider] ?? provider;
}

const UPPER = new Set(["ai", "it", "gpt", "glm", "llm", "moe", "vl", "r1", "v3", "v4", "oss"]);

/**
 * A readable name from a model id, without a catalog: "gemini-3.5-flash-lite" → "Gemini 3.5 Flash Lite",
 * "nvidia/nemotron-3-super-120b-a12b:free" → "Nemotron 3 Super 120B A12B",
 * "@cf/google/gemma-4-26b-a4b-it" → "Gemma 4 26B A4B".
 */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return "";
  let s = id.trim();
  s = s.replace(/^@cf\//, "").replace(/^models\//, "");
  s = s.split("/").at(-1) ?? s;
  s = s.replace(/:free$/i, "");
  // Packaging suffixes ("-instruct-fp8-fast", "-it", a "-0813" snapshot date) are not part of the name.
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/[-_](instruct|it|chat|fp8|fast|\d{4})$/i, "");
  }
  const words = s.split(/[-_ ]+/).filter(Boolean);
  if (words.length === 0) return id;
  return words
    .map((w) => {
      const lower = w.toLowerCase();
      if (/^\d+(\.\d+)?[bmk]$/i.test(w)) return w.toUpperCase();
      if (/^a\d+(\.\d+)?b$/i.test(w)) return w.toUpperCase();
      if (UPPER.has(lower)) return lower.toUpperCase();
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/** The model as a person reads it: "Gemini 3.5 Flash (Google)". */
export function modelDisplayName(ref: { provider?: string | null; model?: string | null }): string {
  const name = modelLabel(ref.model);
  const provider = ref.provider === "openai-compatible" ? endpointShortName(ref.model) || providerShortName(ref.provider) : providerShortName(ref.provider);
  return name && provider ? `${name} (${provider})` : name || provider;
}

const REASON_HE: Record<AiFailureReason, string> = {
  overloaded: "עומס",
  quota: "מכסה",
  timeout: "לא הגיב",
  not_configured: "לא מוגדר",
  bad_key: "מפתח שגוי",
  no_model: "מודל לא זמין",
  error: "שגיאה",
};

const REASON_EN: Record<AiFailureReason, string> = {
  overloaded: "overloaded",
  quota: "quota",
  timeout: "no answer",
  not_configured: "not set up",
  bad_key: "key rejected",
  no_model: "model unavailable",
  error: "error",
};

/** The short reason word: "עומס 503", "מכסה", "לא הגיב 15 ש׳", "לא מוגדר" (or the English equivalents). */
export function attemptReason(attempt: Pick<AiAttempt, "reason" | "status" | "timeout_s"> & { skipped?: boolean }, lang: "he" | "en" = "en"): string {
  const base = reasonWord(attempt, lang);
  // A model skipped for a cooldown failed earlier, not in this turn.
  if (attempt.skipped) return lang === "he" ? `${base} (בהשהיה)` : `${base} (paused)`;
  return base;
}

function reasonWord(attempt: Pick<AiAttempt, "reason" | "status" | "timeout_s">, lang: "he" | "en"): string {
  const reason = (attempt.reason in REASON_EN ? attempt.reason : "error") as AiFailureReason;
  const word = (lang === "he" ? REASON_HE : REASON_EN)[reason];
  if (reason === "timeout") {
    const s = attempt.timeout_s;
    return s ? (lang === "he" ? `${word} ${s} ש׳` : `${word} in ${s} s`) : word;
  }
  if ((reason === "overloaded" || reason === "error") && typeof attempt.status === "number") return `${word} ${attempt.status}`;
  return word;
}

/** One attempt as a line part: "Gemini 3.5 Flash (Google): עומס 503". */
export function formatAttempt(attempt: AiAttempt, lang: "he" | "en" = "en"): string {
  return `${modelDisplayName(attempt)}: ${attemptReason(attempt, lang)}`;
}

/** Every attempt, joined: "Gemini 3.8 Flash (Google): עומס 503 · Gemini 3.5 Flash Lite (Google): עומס 503 · …". */
export function formatAttempts(attempts: readonly AiAttempt[] | null | undefined, lang: "he" | "en" = "en"): string {
  return (attempts ?? []).map((a) => formatAttempt(a, lang)).join(" · ");
}

/** Reads a stored or streamed attribution defensively (older agents send none; JSON may be malformed). */
export function parseAttribution(raw: unknown): AiAttribution | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<AiAttribution>;
  if (typeof v.provider !== "string" || typeof v.model !== "string") return null;
  const attempts = Array.isArray(v.attempts)
    ? v.attempts.filter((a): a is AiAttempt => !!a && typeof a === "object" && typeof (a as AiAttempt).provider === "string" && typeof (a as AiAttempt).model === "string")
    : [];
  return { provider: v.provider, model: v.model, fallback: v.fallback === true, attempts };
}
