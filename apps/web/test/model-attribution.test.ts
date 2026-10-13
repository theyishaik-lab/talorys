import { describe, expect, it } from "vitest";
import type { AiAttempt, AiAttribution } from "@talorys/shared";
import { translate } from "../src/lib/i18n";
import { answeredByView, chatErrorView } from "../src/lib/model-attribution";

const he = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("he", key, vars);
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("en", key, vars);

const a = (provider: string, model: string, reason: AiAttempt["reason"], status: number | null, code: AiAttempt["code"] = "AI_UNAVAILABLE"): AiAttempt => ({ provider, model, code, reason, status, error: "x" });

describe("chat error bubble names the models", () => {
  it("whole chain failed: a Hebrew headline and every model tried with its reason", () => {
    const ai: AiAttribution = {
      provider: "openrouter",
      model: "meta-llama/llama-3.3-70b-instruct:free",
      fallback: true,
      attempts: [
        a("gemini", "gemini-3.8-flash", "overloaded", 503),
        a("gemini", "gemini-3.5-flash-lite", "overloaded", 503),
        a("openrouter", "meta-llama/llama-3.3-70b-instruct:free", "quota", 429, "AI_QUOTA_EXHAUSTED"),
      ],
    };
    const v = chatErrorView({ error: "None of the models answered: …", errorCode: "AI_QUOTA_EXHAUSTED", ai, providerName: "OpenRouter", locale: "he", t: he });
    expect(v.headline).toBe("אף מודל לא ענה.");
    expect(v.tried).toBe("Gemini 3.8 Flash (Google): עומס 503 · Gemini 3.5 Flash Lite (Google): עומס 503 · Llama 3.3 70B (OpenRouter): מכסה");
    expect(v.offerSettings).toBe(true);
  });

  it("one model failed: the usual line plus that model's name and reason", () => {
    const ai: AiAttribution = { provider: "gemini", model: "gemini-3.5-flash", fallback: false, attempts: [a("gemini", "gemini-3.5-flash", "overloaded", 503)] };
    const v = chatErrorView({ error: "Gemini 3.5 Flash (Google): Google Gemini is having trouble right now.", errorCode: "AI_UNAVAILABLE", ai, providerName: "Google Gemini", locale: "he", t: he });
    expect(v.headline).toBe("המודל לא עונה כרגע.");
    expect(v.tried).toBe("Gemini 3.5 Flash (Google): עומס 503");
    const timeout = chatErrorView({ error: "x", errorCode: "AI_UNAVAILABLE", ai: { ...ai, attempts: [{ ...a("gemini", "gemini-3.8-flash", "timeout", null), timeout_s: 15 }] }, providerName: "", locale: "en", t: en });
    expect(timeout.tried).toBe("Gemini 3.8 Flash (Google): no answer in 15 s");
  });

  it("an older agent (no attribution) shows what it always showed", () => {
    const v = chatErrorView({ error: "The AI model could not respond.", errorCode: "AI_UNAVAILABLE", ai: null, providerName: "Google Gemini", locale: "he", t: he });
    expect(v).toEqual({ headline: "The AI model could not respond.", tried: null, offerSettings: false });
    expect(chatErrorView({ error: "q", errorCode: "AI_QUOTA_EXHAUSTED", providerName: "Google Gemini", locale: "en", t: en }).headline).toContain("Google Gemini");
  });
});

describe("answered-by note", () => {
  it("names the backup that wrote the reply", () => {
    const ai: AiAttribution = { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", fallback: true, attempts: [a("gemini", "gemini-3.5-flash", "overloaded", 503)] };
    expect(answeredByView(ai, false, "he", he)).toEqual({
      text: "ענה: Nemotron 3 Super 120B A12B (OpenRouter)",
      title: "המודל שנבחר לא ענה: Gemini 3.5 Flash (Google): עומס 503",
    });
  });
  it("stays hidden when the chosen model answered, on errors, and for older agents", () => {
    expect(answeredByView({ provider: "gemini", model: "g", fallback: false, attempts: [] }, false, "he", he)).toBeNull();
    expect(answeredByView({ provider: "gemini", model: "g", fallback: true, attempts: [] }, true, "he", he)).toBeNull();
    expect(answeredByView(undefined, false, "he", he)).toBeNull();
  });
});
