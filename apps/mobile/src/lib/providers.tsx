import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useColorScheme } from "react-native";
import { I18nContext, type Locale, type LocalePreference, applyDirection, readLocalePreference, resolveLocale, translate, writeLocalePreference } from "./i18n";
import { ThemeContext, type ThemeMode, palettes, readThemeMode, resolveScheme, writeThemeMode } from "./theme";

const PREFS_TIMEOUT_MS = 2500;

/** Theme + locale providers. `ready` becomes true once both preferences were read from disk. */
export function useAppPreferences(): { ready: boolean; themeMode: ThemeMode; localePref: LocalePreference; needsRestart: boolean } & {
  setThemeMode: (m: ThemeMode) => void;
  setLocalePref: (p: LocalePreference) => void;
} {
  const [ready, setReady] = useState(false);
  const [themeMode, setThemeModeState] = useState<ThemeMode>("system");
  const [localePref, setLocalePrefState] = useState<LocalePreference>("auto");
  const [needsRestart, setNeedsRestart] = useState(false);

  useEffect(() => {
    // The stores answer in milliseconds; if one never answers (a broken native module, a locked
    // keystore) the app still opens with defaults after PREFS_TIMEOUT_MS instead of a blank screen.
    let done = false;
    const finish = (theme: ThemeMode, locale: LocalePreference) => {
      if (done) return;
      done = true;
      setThemeModeState(theme);
      setLocalePrefState(locale);
      try {
        applyDirection(resolveLocale(locale));
      } catch (e) {
        console.warn("applyDirection failed", e);
      }
      setReady(true);
    };
    const timer = setTimeout(() => finish("system", "auto"), PREFS_TIMEOUT_MS);
    Promise.all([readThemeMode(), readLocalePreference()])
      .then(([theme, locale]) => finish(theme, locale))
      .catch(() => finish("system", "auto"))
      .finally(() => clearTimeout(timer));
    return () => clearTimeout(timer);
  }, []);

  const setThemeMode = useCallback((m: ThemeMode) => {
    setThemeModeState(m);
    writeThemeMode(m);
  }, []);
  const setLocalePref = useCallback((p: LocalePreference) => {
    setLocalePrefState(p);
    writeLocalePreference(p);
    if (applyDirection(resolveLocale(p))) setNeedsRestart(true);
  }, []);

  return { ready, themeMode, localePref, needsRestart, setThemeMode, setLocalePref };
}

export function AppProviders({
  themeMode,
  setThemeMode,
  localePref,
  setLocalePref,
  children,
}: {
  themeMode: ThemeMode;
  setThemeMode: (m: ThemeMode) => void;
  localePref: LocalePreference;
  setLocalePref: (p: LocalePreference) => void;
  children: ReactNode;
}) {
  const system = useColorScheme();
  const scheme = resolveScheme(themeMode, system);
  const theme = useMemo(() => ({ scheme, mode: themeMode, c: palettes[scheme], setMode: setThemeMode }), [scheme, themeMode, setThemeMode]);
  const locale: Locale = useMemo(() => resolveLocale(localePref), [localePref]);
  const i18n = useMemo(
    () => ({ locale, pref: localePref, rtl: locale === "he", t: (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate(locale, key, vars), setPreference: setLocalePref }),
    [locale, localePref, setLocalePref],
  );
  return (
    <ThemeContext.Provider value={theme}>
      <I18nContext.Provider value={i18n}>{children}</I18nContext.Provider>
    </ThemeContext.Provider>
  );
}
