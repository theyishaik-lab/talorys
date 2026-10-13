import { describe, expect, it } from "vitest";
import { pagesEn, pagesHe } from "../src/lib/strings-pages";
import { translate } from "../src/lib/i18n";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("page strings", () => {
  it("has a Hebrew string for every key, with the same placeholders", () => {
    for (const key of Object.keys(pagesEn) as (keyof typeof pagesEn)[]) {
      expect(pagesHe[key], key).toBeTruthy();
      expect(placeholders(pagesHe[key]), key).toEqual(placeholders(pagesEn[key]));
    }
  });
  it("is reachable through translate()", () => {
    expect(translate("en", "tasks.deleteMessage", { title: "Milk" })).toBe("“Milk” will be permanently deleted.");
    expect(translate("he", "auto.desc.hours", { n: 3 })).toBe("כל 3 שעות");
  });
});
