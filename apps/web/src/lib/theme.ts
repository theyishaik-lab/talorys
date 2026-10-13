export type ThemePreference = "system" | "light" | "dark";

const KEY = "talorys.theme";
let media: MediaQueryList | null = null;

export function readThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function resolve(pref: ThemePreference): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolvedTheme(): "light" | "dark" {
  return resolve(readThemePreference());
}

/**
 * "light" / "dark" force a scheme with a class on <html>; "system" removes both so the stylesheet's
 * prefers-color-scheme block decides (that block applies before any script runs, so "auto" never
 * flashes the wrong scheme on first paint).
 */
export function applyTheme(pref: ThemePreference): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* storage unavailable */
  }
  const root = document.documentElement;
  const set = () => {
    root.classList.toggle("dark", pref === "dark");
    root.classList.toggle("light", pref === "light");
    root.dataset.theme = resolve(pref);
    syncThemeColor();
  };
  set();
  media?.removeEventListener("change", set);
  if (pref === "system") {
    media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", set);
  }
}

/** Keeps the browser/OS chrome (status bar in an installed app) in step with the active scheme. */
function syncThemeColor(): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])');
  if (!meta) return;
  // The two --bg values from the stylesheet; a constant here avoids forcing a synchronous style
  // recalculation of the whole page on every switch.
  meta.content = resolvedTheme() === "dark" ? "#0b0b0e" : "#ffffff";
}

/** Applies the last known theme before first render (no inline scripts under our CSP). */
export function initTheme(): void {
  applyTheme(readThemePreference());
}
