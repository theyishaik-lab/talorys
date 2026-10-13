import { describe, expect, it } from "vitest";
import { type ChainStatusEntry, moveItem, settingsPatchForChain } from "@talorys/shared";
import { quotaLine, stateText, timeLeft } from "../src/lib/chain-view";
import { translate } from "../src/lib/i18n";

const he = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("he", key, vars);
const NOW = Date.parse("2026-10-13T21:00:00Z");
const entry = (over: Partial<ChainStatusEntry>): ChainStatusEntry => ({
  provider: "openrouter",
  model: "nvidia/ultra:free",
  position: 0,
  label: "Nemotron 3 Ultra",
  provider_label: "OpenRouter",
  state: "available",
  until: null,
  reason: null,
  error: null,
  quota: null,
  ...over,
});

describe("model chain screen words", () => {
  it("says the state, when it comes back and what is left, in Hebrew", () => {
    expect(timeLeft(he, new Date(NOW + 90 * 60_000).toISOString(), NOW)).toBe("1 שע׳ 30 דק׳");
    expect(stateText(he, entry({ state: "exhausted", reason: "quota", until: new Date(NOW + 3 * 3_600_000).toISOString() }), NOW)).toBe("המכסה היומית נגמרה · מתאפסת בעוד 3 שע׳");
    expect(stateText(he, entry({ state: "paused", reason: "timeout", until: new Date(NOW + 5 * 60_000).toISOString() }), NOW)).toBe("בהשהיה (לא הגיב) · חוזר בעוד 5 דק׳");
    expect(quotaLine(he, null)).toBe("מכסה: לא ידוע");
    expect(quotaLine(he, { requests: { remaining: 30, limit: 50, window: "day", reset_at: null }, tokens: null, source: "key_api", as_of: new Date(NOW).toISOString(), shared: true })).toBe(
      "נותרו 30 מתוך 50 בקשות היום · משותף לכל המודלים החינמיים",
    );
  });

  it("writes a reordered list back as model, backup and chain", () => {
    const list = [
      { provider: "openrouter" as const, model: "a:free" },
      { provider: "gemini" as const, model: "gemini-3.8-flash" },
      { provider: "openai-compatible" as const, model: "groq/openai/gpt-oss-120b" },
    ];
    expect(settingsPatchForChain(moveItem(list, 2, 0))).toEqual({
      modelProvider: "openai-compatible",
      model: "groq/openai/gpt-oss-120b",
      fallback: { provider: "openrouter", model: "a:free", chain: [{ provider: "gemini", model: "gemini-3.8-flash" }] },
    });
  });
});
