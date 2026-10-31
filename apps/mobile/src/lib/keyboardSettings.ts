/**
 * Pure helpers for Settings → Keyboard (the Android keyboard that ships inside the app since 0.4.0).
 * Kept free of native imports so they are unit-tested; the screen talks to the native module through
 * modules/talorys-keyboard.
 */
import type { StringKey } from "./i18n";

/** What the native module reports about setup (subset of KeyboardStatus). */
export interface SetupStatus {
  keyboardEnabled: boolean;
  keyboardSelected: boolean;
  accessibilityEnabled: boolean;
  defaultAssistant: boolean;
}

export type SetupAction = "openInputMethodSettings" | "showInputMethodPicker" | "openAccessibilitySettings" | "openAssistantSettings";

export interface SetupStep {
  key: "enable" | "select" | "accessibility" | "assistant";
  title: StringKey;
  hint: StringKey;
  done: boolean;
  optional: boolean;
  action: SetupAction;
  actionLabel: StringKey;
  /** Switching to the keyboard only works once it is enabled. */
  actionEnabled: boolean;
}

/** The setup checklist, in order: enable → switch to it → (optional) screen context → (optional) assistant. */
export function setupSteps(s: SetupStatus): SetupStep[] {
  return [
    { key: "enable", title: "kb.setup.enable", hint: "kb.setup.enableHint", done: s.keyboardEnabled, optional: false, action: "openInputMethodSettings", actionLabel: "kb.action.enable", actionEnabled: true },
    { key: "select", title: "kb.setup.select", hint: "kb.setup.selectHint", done: s.keyboardSelected, optional: false, action: "showInputMethodPicker", actionLabel: "kb.action.switch", actionEnabled: s.keyboardEnabled },
    { key: "accessibility", title: "kb.setup.accessibility", hint: "kb.setup.accessibilityHint", done: s.accessibilityEnabled, optional: true, action: "openAccessibilitySettings", actionLabel: "kb.action.open", actionEnabled: true },
    { key: "assistant", title: "kb.setup.assistant", hint: "kb.setup.assistantHint", done: s.defaultAssistant, optional: true, action: "openAssistantSettings", actionLabel: "kb.action.open", actionEnabled: true },
  ];
}

/** True when the required steps are done (the keyboard is on and in use). */
export function isReady(s: SetupStatus): boolean {
  return s.keyboardEnabled && s.keyboardSelected;
}

/** Key-height presets as the old native settings named them (Compact, Normal, Tall +25%, Extra tall). */
export const KEY_HEIGHT_LABELS: StringKey[] = ["kb.keyHeight.compact", "kb.keyHeight.normal", "kb.keyHeight.tall", "kb.keyHeight.extraTall"];

/** Index of the preset [value] matches (within 0.6 dp, like the native screen), or -1 for a custom height. */
export function keyHeightPresetIndex(value: number, presets: readonly number[]): number {
  return presets.findIndex((p) => Math.abs(p - value) < 0.6);
}

/** One step of the − / + key-height control: whole dp, clamped to the keyboard's range. */
export function stepKeyHeight(value: number, delta: number, min: number, max: number): number {
  const next = Math.round(value) + delta;
  return Math.min(max, Math.max(min, next));
}

/** Clipboard expiry choices (ms) → label keys; 0 means never. */
export function expiryLabel(ms: number): StringKey {
  if (ms === 0) return "kb.clip.expiry.never";
  if (ms <= 15 * 60_000) return "kb.clip.expiry.15m";
  if (ms <= 60 * 60_000) return "kb.clip.expiry.1h";
  return "kb.clip.expiry.1d";
}

/** Haptic strength 0..5 → a label key and its level. */
export function hapticLabel(level: number): { key: StringKey; level: number } {
  const l = Math.min(5, Math.max(0, Math.round(level)));
  return l === 0 ? { key: "kb.haptics.off", level: 0 } : { key: "kb.haptics.level", level: l };
}

/** Sound volume 0..1 in steps of 0.1 (the − / + control). */
export function stepVolume(value: number, delta: number): number {
  return Math.min(1, Math.max(0, Math.round((value + delta) * 10) / 10));
}

/**
 * Package names from the excluded-apps editor: one per line (commas and spaces also split), the same
 * rule as the keyboard's ScreenPolicy.parseList (the native side validates again on save).
 */
export function parseExcludedApps(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,\s]+/)) {
    const s = raw.trim();
    if (/^[A-Za-z]\w*(\.\w+)+$/.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * What the keyboard gets from the app's session: the server origin (the keyboard adds /api itself)
 * and the token. Signed out → both cleared on the keyboard side as far as the token goes.
 */
export function keyboardSession(s: { token: string | null; server: string }): { server: string | null; token: string | null } {
  const server = s.server.trim().replace(/\/+$/, "");
  const token = s.token?.trim();
  return { server: server || null, token: token || null };
}

/** The subtitle of a learned-words status line. */
export function dictionarySummary(d: { learnedWords: number; lastSync: number; backupEnabled: boolean; signedIn: boolean }): { key: StringKey; vars: Record<string, string | number> } {
  if (!d.signedIn) return { key: "kb.words.localOnly", vars: { n: d.learnedWords } };
  if (!d.backupEnabled) return { key: "kb.words.localOnly", vars: { n: d.learnedWords } };
  if (!d.lastSync) return { key: "kb.words.neverSynced", vars: { n: d.learnedWords } };
  return { key: "kb.words.lastSync", vars: { n: d.learnedWords, when: new Date(d.lastSync).toLocaleString() } };
}
