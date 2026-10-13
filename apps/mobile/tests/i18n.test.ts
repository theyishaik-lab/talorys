import { describe, expect, it } from "vitest";
import strings from "../src/lib/strings.json";
import { detectLocale, firstStrongDirection, format, translate } from "../src/lib/i18n";

describe("i18n", () => {
  it("has every key in both languages", () => {
    expect(Object.keys(strings.he).sort()).toEqual(Object.keys(strings.en).sort());
  });
  it("detects Hebrew from device tags, including the legacy iw tag", () => {
    expect(detectLocale(["iw-IL"])).toBe("he");
    expect(detectLocale(["en-US", "he-IL"])).toBe("en");
    expect(detectLocale(["fr-FR"])).toBe("en");
  });
  it("formats placeholders and falls back to English", () => {
    expect(format("Hi {name}", { name: "ישי" })).toBe("Hi ישי");
    expect(translate("he", "chat.new")).toBe("צ'אט חדש");
  });
  it("picks text direction by the first strong character", () => {
    expect(firstStrongDirection("שלום world")).toBe("rtl");
    expect(firstStrongDirection("123 hello")).toBe("ltr");
    expect(firstStrongDirection("…", "rtl")).toBe("rtl");
  });
});
