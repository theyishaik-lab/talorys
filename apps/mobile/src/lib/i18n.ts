import AsyncStorage from "@react-native-async-storage/async-storage";
import { getLocales } from "expo-localization";
import { createContext, useContext } from "react";
import { I18nManager } from "react-native";
import strings from "./strings.json";

/** Same locale model as the web app (apps/web/src/lib/i18n.tsx): auto | en | he, Hebrew flips the shell to RTL. */
export type Locale = "en" | "he";
export type LocalePreference = "auto" | Locale;
export type StringKey = keyof typeof strings.en;

const KEY = "talorys.lang";
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", he: "עברית" };

export function detectLocale(tags: readonly string[]): Locale {
  for (const tag of tags) {
    const base = tag.toLowerCase().split(/[-_]/)[0];
    if (base === "he" || base === "iw") return "he";
    if (base === "en") return "en";
  }
  return "en";
}

export function deviceLocale(): Locale {
  return detectLocale(getLocales().map((l) => l.languageTag));
}

export async function readLocalePreference(): Promise<LocalePreference> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v === "en" || v === "he" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function writeLocalePreference(pref: LocalePreference): void {
  AsyncStorage.setItem(KEY, pref).catch(() => {});
}

export function resolveLocale(pref: LocalePreference): Locale {
  return pref === "auto" ? deviceLocale() : pref;
}

export function isRTL(locale: Locale): boolean {
  return locale === "he";
}

/**
 * Android applies a forced direction on the next process start; the caller tells the person to restart
 * when the value actually changed.
 */
export function applyDirection(locale: Locale): boolean {
  const rtl = isRTL(locale);
  I18nManager.allowRTL(true);
  if (I18nManager.isRTL !== rtl) {
    I18nManager.forceRTL(rtl);
    return true;
  }
  return false;
}

export function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function translate(locale: Locale, key: StringKey, vars?: Record<string, string | number>): string {
  const table = locale === "he" ? strings.he : strings.en;
  return format((table as Record<string, string>)[key] ?? strings.en[key] ?? key, vars);
}

/** Direction of a piece of text by its first strong character (what dir="auto" does on the web). */
export function firstStrongDirection(text: string, fallback: "ltr" | "rtl" = "ltr"): "ltr" | "rtl" {
  for (const ch of text) {
    if (/[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u.test(ch)) return "rtl";
    if (/\p{L}/u.test(ch)) return "ltr";
  }
  return fallback;
}

export interface I18n {
  locale: Locale;
  pref: LocalePreference;
  rtl: boolean;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
  setPreference: (pref: LocalePreference) => void;
}

export const I18nContext = createContext<I18n>({
  locale: "en",
  pref: "auto",
  rtl: false,
  t: (key, vars) => translate("en", key, vars),
  setPreference: () => {},
});
export const useI18n = () => useContext(I18nContext);
