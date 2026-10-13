import * as pkg from "@talorys/shared";
import { describe, expect, it } from "vitest";
import * as local from "../src/lib/shared";

/** The source of every file under src/, by path. */
const sources = import.meta.glob("../src/**/*.{ts,tsx}", { eager: true, query: "?raw", import: "default" });
describe("shared runtime helpers", () => {
  it("re-exports the package's own functions, and the chain cap matches", () => {
    expect(local.moveItem).toBe(pkg.moveItem);
    expect(local.settingsPatchForChain).toBe(pkg.settingsPatchForChain);
    expect(local.endpointIdFromName).toBe(pkg.endpointIdFromName);
    expect(local.modelLabel).toBe(pkg.modelLabel);
    expect(local.modelDisplayName).toBe(pkg.modelDisplayName);
    expect(local.formatAttempts).toBe(pkg.formatAttempts);
    expect(local.MAX_FALLBACK_CHAIN).toBe(pkg.MAX_FALLBACK_CHAIN);
  });

  it("src/ imports only types from @talorys/shared (Metro cannot bundle the package)", () => {
    const bad: string[] = [];
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    for (const [f, src] of Object.entries(sources)) {
      for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"@talorys\/shared[^"]*"/g)) {
        if (m[1]) continue;
        const values = (m[2] ?? "").split(",").map((x: string) => x.trim()).filter((x: string) => x && !x.startsWith("type "));
        if (values.length) bad.push(`${f}: ${values.join(", ")}`);
      }
      if (/import\s+(\*|[A-Za-z_$][\w$]*)\s+(as\s+\w+\s+)?from\s+"@talorys\/shared/.test(src)) bad.push(`${f}: default/namespace import`);
    }
    expect(bad).toEqual([]);
  });
});
