import { describe, expect, it } from "vitest";
import { detectLocale, directionOf, firstStrongDirection, resolveLocale, translate } from "../src/lib/i18n";

describe("detectLocale", () => {
  it("picks Hebrew from any Hebrew tag, including the legacy iw code", () => {
    expect(detectLocale(["he-IL", "en-US"])).toBe("he");
    expect(detectLocale(["iw"])).toBe("he");
    expect(detectLocale(["HE"])).toBe("he");
  });
  it("prefers the first supported language in order", () => {
    expect(detectLocale(["en-GB", "he"])).toBe("en");
    expect(detectLocale(["fr-FR", "he-IL"])).toBe("he");
  });
  it("falls back to English", () => {
    expect(detectLocale([])).toBe("en");
    expect(detectLocale(["fr", "de"])).toBe("en");
  });
  it("resolves an explicit preference over the browser", () => {
    expect(resolveLocale("en", ["he-IL"])).toBe("en");
    expect(resolveLocale("he", ["en-US"])).toBe("he");
    expect(resolveLocale("auto", ["he-IL"])).toBe("he");
  });
});

describe("directionOf", () => {
  it("is rtl for Hebrew only", () => {
    expect(directionOf("he")).toBe("rtl");
    expect(directionOf("en")).toBe("ltr");
  });
});

describe("firstStrongDirection", () => {
  it("follows the first letter, skipping digits, punctuation and symbols", () => {
    expect(firstStrongDirection("שלום world")).toBe("rtl");
    expect(firstStrongDirection("hello שלום")).toBe("ltr");
    expect(firstStrongDirection("123 — שלום")).toBe("rtl");
    expect(firstStrongDirection("- `code` שלום")).toBe("ltr");
    expect(firstStrongDirection("https://x.y שלום")).toBe("ltr");
  });
  it("uses the fallback when nothing is strong", () => {
    expect(firstStrongDirection("123 !!")).toBe("ltr");
    expect(firstStrongDirection("", "rtl")).toBe("rtl");
  });
});

describe("translate", () => {
  it("returns Hebrew strings and interpolates variables", () => {
    expect(translate("he", "nav.settings")).toBe("הגדרות");
    expect(translate("en", "login.tryAgainIn", { n: 7 })).toBe("Try again in 7s");
    expect(translate("he", "chat.placeholder", { name: "טל" })).toBe("שאל את טל כל דבר…");
  });
  it("has a Hebrew string for every English key", () => {
    // The dictionary type enforces this at compile time; this guards against empty strings.
    const sample = ["nav.chat", "chat.new", "settings.language", "login.unlock"] as const;
    for (const key of sample) expect(translate("he", key).length).toBeGreaterThan(0);
  });
});
