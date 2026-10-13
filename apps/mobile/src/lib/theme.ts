import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext } from "react";
import type { ColorSchemeName } from "react-native";

/** Design tokens ported from the approved mockups (tasks/…/mock/base.css). Brand accent is a placeholder. */
export const palettes = {
  light: {
    bg: "#FFFFFF",
    surface: "#F5F5F7",
    surface2: "#ECECEF",
    elev: "#FFFFFF",
    border: "#E6E6EA",
    borderStrong: "#D4D4DA",
    fg: "#0E0E12",
    fg2: "#3C3C44",
    fgMuted: "#71717C",
    fgFaint: "#A1A1AA",
    accent: "#4C47E0",
    accentFg: "#FFFFFF",
    accentSoft: "#EEEDFD",
    accentText: "#4038D4",
    success: "#15803D",
    successSoft: "#E7F6EC",
    warning: "#B45309",
    danger: "#DC2626",
    dangerSoft: "#FDECEC",
    bubbleUser: "#0E0E12",
    bubbleUserFg: "#FFFFFF",
    scrim: "rgba(10,10,14,0.32)",
  },
  dark: {
    bg: "#0B0B0E",
    surface: "#16161A",
    surface2: "#1F1F25",
    elev: "#18181D",
    border: "#26262D",
    borderStrong: "#34343C",
    fg: "#F2F2F4",
    fg2: "#C9C9D1",
    fgMuted: "#8E8E99",
    fgFaint: "#5E5E68",
    accent: "#8F8CFF",
    accentFg: "#0B0B0E",
    accentSoft: "#1E1D3A",
    accentText: "#ABA9FF",
    success: "#4ADE80",
    successSoft: "#11281A",
    warning: "#FBBF24",
    danger: "#F87171",
    dangerSoft: "#2A1414",
    bubbleUser: "#26262E",
    bubbleUserFg: "#F2F2F4",
    scrim: "rgba(0,0,0,0.55)",
  },
} as const;

export type Palette = { [K in keyof (typeof palettes)["light"]]: string };
export type ThemeMode = "system" | "light" | "dark";
export type Scheme = "light" | "dark";

export const radii = { sm: 10, md: 14, lg: 20, xl: 28 } as const;
export const space = (n: number) => n * 4;

/** Inter for Latin, Heebo for Hebrew. RN picks glyph fallbacks per font, so the pair is chosen per locale. */
export const fonts = {
  en: { regular: "Inter_400Regular", medium: "Inter_500Medium", semibold: "Inter_600SemiBold" },
  he: { regular: "Heebo_400Regular", medium: "Heebo_500Medium", semibold: "Heebo_600SemiBold" },
} as const;

export interface Theme {
  scheme: Scheme;
  mode: ThemeMode;
  c: Palette;
  setMode: (mode: ThemeMode) => void;
}

export const ThemeContext = createContext<Theme>({ scheme: "light", mode: "system", c: palettes.light, setMode: () => {} });
export const useTheme = () => useContext(ThemeContext);

const KEY = "talorys.theme";
export async function readThemeMode(): Promise<ThemeMode> {
  try {
    const v = await AsyncStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}
export function writeThemeMode(mode: ThemeMode): void {
  AsyncStorage.setItem(KEY, mode).catch(() => {});
}
export function resolveScheme(mode: ThemeMode, system: ColorSchemeName): Scheme {
  if (mode === "system") return system === "dark" ? "dark" : "light";
  return mode;
}
