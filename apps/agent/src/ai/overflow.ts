/** Provider wording for "the prompt does not fit this model's context window". */
export const OVERFLOW_RE =
  /context[_ ]length|context window|maximum context|prompt is too long|input is too long|too many input tokens|exceeds? (?:the )?(?:model'?s? )?(?:max(?:imum)?) (?:context|input|prompt)|input token count|request too large|reduce the length of the (?:messages|prompt)|longer than (?:this|the) model'?s context/i;

/** True when raw provider error text says the prompt does not fit the model's context window. */
export function looksLikeContextOverflow(text: string, status?: number | null): boolean {
  if (status === 429) return false; // tokens-per-minute rate limits, not the window
  return OVERFLOW_RE.test(text);
}

