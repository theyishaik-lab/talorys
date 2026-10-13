import { describe, expect, it } from "vitest";
import type { ChainStatusEntry } from "@talorys/shared";
import { quotaLine, stateText, timeLeft } from "../src/lib/chain-view";
import { translate } from "../src/lib/i18n";

const he = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("he", key, vars);
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("en", key, vars);
const NOW = Date.parse("2026-10-13T21:00:00Z");

const entry = (over: Partial<ChainStatusEntry>): ChainStatusEntry => ({
  provider: "gemini",
  model: "gemini-3.8-flash",
  position: 0,
  label: "Gemini 3.8 Flash",
  provider_label: "Google",
  state: "available",
  until: null,
  reason: null,
  error: null,
  quota: null,
  ...over,
});

describe("model chain words", () => {
  it("time left in minutes and hours", () => {
    expect(timeLeft(he, new Date(NOW + 12 * 60_000).toISOString(), NOW)).toBe("12 דק׳");
    expect(timeLeft(he, new Date(NOW + 185 * 60_000).toISOString(), NOW)).toBe("3 שע׳ 5 דק׳");
    expect(timeLeft(en, new Date(NOW + 120 * 60_000).toISOString(), NOW)).toBe("2 h");
    expect(timeLeft(he, new Date(NOW - 1).toISOString(), NOW)).toBe("פחות מדקה");
  });

  it("states: available, paused with why and when, daily quota used up, not set up", () => {
    expect(stateText(he, entry({}))).toBe("זמין");
    expect(stateText(he, entry({ state: "paused", reason: "overloaded", until: new Date(Date.now() + 5 * 60_000).toISOString() }))).toMatch(/^בהשהיה \(עומס\) · חוזר בעוד [45] דק׳$/);
    expect(stateText(he, entry({ state: "exhausted", reason: "quota", until: new Date(Date.now() + 3 * 3_600_000 + 30_000).toISOString() }))).toBe("המכסה היומית נגמרה · מתאפסת בעוד 3 שע׳ 1 דק׳");
    expect(stateText(he, entry({ state: "not_configured", reason: "not_configured" }))).toBe("לא מוגדר");
  });

  it("quota: OpenRouter's shared daily allowance, Groq's headers, and unknown", () => {
    expect(quotaLine(he, null)).toBe("מכסה: לא ידוע");
    expect(
      quotaLine(he, { requests: { remaining: 30, limit: 50, window: "day", reset_at: null }, tokens: null, source: "key_api", as_of: new Date(NOW).toISOString(), shared: true }),
    ).toBe("נותרו 30 מתוך 50 בקשות היום · משותף לכל המודלים החינמיים");
    const groq = quotaLine(en, { requests: { remaining: 987, limit: 1000, window: "day", reset_at: null }, tokens: { remaining: 7412, limit: 8000, window: "minute", reset_at: null }, source: "headers", as_of: new Date(NOW).toISOString(), shared: false });
    expect(groq).toMatch(/^987 of 1,000 requests left today · 7,412 tokens\/min · as of /);
  });
});
