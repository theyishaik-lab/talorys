import { describe, expect, it } from "vitest";
import strings from "../src/lib/strings.json";
import {
  dictionarySummary,
  expiryLabel,
  hapticLabel,
  isReady,
  keyHeightPresetIndex,
  keyboardSession,
  parseExcludedApps,
  setupSteps,
  stepKeyHeight,
  stepVolume,
} from "../src/lib/keyboardSettings";
import { getServerUrl, loadSession, onSessionChange, setSession } from "../src/lib/session";

/** Settings → Keyboard (the Android keyboard merged into the app in 0.4.0) and its one-login session hand-off. */
describe("keyboard settings", () => {
  const off = { keyboardEnabled: false, keyboardSelected: false, accessibilityEnabled: false, defaultAssistant: false };

  it("orders the setup steps and only offers Switch once the keyboard is enabled", () => {
    const steps = setupSteps(off);
    expect(steps.map((s) => s.key)).toEqual(["enable", "select", "accessibility", "assistant"]);
    expect(steps.map((s) => s.action)).toEqual(["openInputMethodSettings", "showInputMethodPicker", "openAccessibilitySettings", "openAssistantSettings"]);
    expect(steps[1]!.actionEnabled).toBe(false);
    expect(steps.filter((s) => s.optional).map((s) => s.key)).toEqual(["accessibility", "assistant"]);
    const on = setupSteps({ ...off, keyboardEnabled: true });
    expect(on[0]!.done).toBe(true);
    expect(on[1]!.actionEnabled).toBe(true);
    expect(isReady({ ...off, keyboardEnabled: true })).toBe(false);
    expect(isReady({ ...off, keyboardEnabled: true, keyboardSelected: true })).toBe(true);
  });

  it("every label key it uses exists in both languages", () => {
    const keys = [
      ...setupSteps(off).flatMap((s) => [s.title, s.hint, s.actionLabel]),
      ...[0, 900_000, 3_600_000, 86_400_000].map(expiryLabel),
      hapticLabel(0).key,
      hapticLabel(3).key,
      dictionarySummary({ learnedWords: 1, lastSync: 0, backupEnabled: true, signedIn: true }).key,
    ];
    for (const k of keys) {
      expect(strings.en, k).toHaveProperty([k]);
      expect(strings.he, k).toHaveProperty([k]);
    }
  });

  it("matches key-height presets like the native screen did (within 0.6 dp)", () => {
    const presets = [50, 56, 62.5, 70];
    expect(keyHeightPresetIndex(56, presets)).toBe(1);
    expect(keyHeightPresetIndex(62, presets)).toBe(2);
    expect(keyHeightPresetIndex(63, presets)).toBe(2);
    expect(keyHeightPresetIndex(60, presets)).toBe(-1);
    expect(stepKeyHeight(62.5, 1, 44, 76)).toBe(64);
    expect(stepKeyHeight(44, -1, 44, 76)).toBe(44);
    expect(stepKeyHeight(76, 1, 44, 76)).toBe(76);
  });

  it("labels clipboard expiry, haptics and volume steps", () => {
    expect(expiryLabel(0)).toBe("kb.clip.expiry.never");
    expect(expiryLabel(15 * 60_000)).toBe("kb.clip.expiry.15m");
    expect(expiryLabel(60 * 60_000)).toBe("kb.clip.expiry.1h");
    expect(expiryLabel(24 * 60 * 60_000)).toBe("kb.clip.expiry.1d");
    expect(hapticLabel(0)).toEqual({ key: "kb.haptics.off", level: 0 });
    expect(hapticLabel(9)).toEqual({ key: "kb.haptics.level", level: 5 });
    expect(stepVolume(0.5, 0.1)).toBe(0.6);
    expect(stepVolume(0.95, 0.1)).toBe(1);
    expect(stepVolume(0.05, -0.1)).toBe(0);
  });

  it("parses the excluded-apps editor like ScreenPolicy.parseList", () => {
    expect(parseExcludedApps("com.bank.app\n  com.x8bit.bitwarden, junk  nodot\ncom.bank.app\n1com.bad.start")).toEqual(["com.bank.app", "com.x8bit.bitwarden"]);
    expect(parseExcludedApps("")).toEqual([]);
  });

  it("summarises learned words and backup state", () => {
    expect(dictionarySummary({ learnedWords: 5, lastSync: 0, backupEnabled: true, signedIn: false }).key).toBe("kb.words.localOnly");
    expect(dictionarySummary({ learnedWords: 5, lastSync: 0, backupEnabled: false, signedIn: true }).key).toBe("kb.words.localOnly");
    expect(dictionarySummary({ learnedWords: 5, lastSync: 0, backupEnabled: true, signedIn: true }).key).toBe("kb.words.neverSynced");
    const synced = dictionarySummary({ learnedWords: 5, lastSync: Date.UTC(2026, 9, 31), backupEnabled: true, signedIn: true });
    expect(synced.key).toBe("kb.words.lastSync");
    expect(synced.vars.n).toBe(5);
  });
});

describe("one login: the keyboard gets the app's session", () => {
  it("maps the session to what the native module stores", () => {
    expect(keyboardSession({ token: "abc", server: "https://x.pages.dev/" })).toEqual({ server: "https://x.pages.dev", token: "abc" });
    expect(keyboardSession({ token: null, server: "https://x.pages.dev" })).toEqual({ server: "https://x.pages.dev", token: null });
    expect(keyboardSession({ token: "  ", server: "" })).toEqual({ server: null, token: null });
  });

  it("tells listeners on load, sign-in and sign-out, and a throwing listener breaks nothing", async () => {
    const seen: Array<{ token: string | null; server: string }> = [];
    const offBad = onSessionChange(() => {
      throw new Error("native module gone");
    });
    const off = onSessionChange((s) => seen.push(s));
    await setSession({ token: "t1", server: "my-talorys.pages.dev/api" });
    expect(seen.at(-1)).toEqual({ token: "t1", server: "https://my-talorys.pages.dev" });
    await loadSession();
    expect(seen.at(-1)).toEqual({ token: "t1", server: "https://my-talorys.pages.dev" });
    await setSession({ token: null });
    expect(seen.at(-1)).toEqual({ token: null, server: getServerUrl() });
    off();
    offBad();
    const n = seen.length;
    await setSession({ token: "t2" });
    expect(seen.length).toBe(n);
    await setSession({ token: null });
  });
});
