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
