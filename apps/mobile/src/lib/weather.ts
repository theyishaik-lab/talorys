import type { StringKey } from "./i18n";

/**
 * Weather for the Home screen from Open-Meteo (free, no API key): current conditions plus today's
 * high and low at the phone's approximate location. Pure helpers here (URL, parsing, WMO codes) so
 * they are unit-testable; the location permission lives in location.ts.
 */
export interface Weather {
  temperature: number;
  apparentTemperature: number | null;
  code: number;
  isDay: boolean;
  high: number | null;
  low: number | null;
  /** When Open-Meteo measured the current values (the place's local time, ISO without zone). */
  time: string | null;
}

export function weatherUrl(lat: number, lon: number): string {
  const q = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lon.toFixed(3),
    current: "temperature_2m,apparent_temperature,weather_code,is_day",
    daily: "temperature_2m_max,temperature_2m_min",
    timezone: "auto",
    forecast_days: "1",
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

interface OpenMeteoResponse {
  current?: { time?: string; temperature_2m?: number; apparent_temperature?: number; weather_code?: number; is_day?: number };
  daily?: { temperature_2m_max?: (number | null)[]; temperature_2m_min?: (number | null)[] };
}

export function parseWeather(body: unknown): Weather | null {
  const r = body as OpenMeteoResponse | null;
  const cur = r?.current;
  if (!cur || typeof cur.temperature_2m !== "number") return null;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    temperature: cur.temperature_2m,
    apparentTemperature: num(cur.apparent_temperature),
    code: typeof cur.weather_code === "number" ? cur.weather_code : -1,
    isDay: cur.is_day !== 0,
    high: num(r?.daily?.temperature_2m_max?.[0]),
    low: num(r?.daily?.temperature_2m_min?.[0]),
    time: cur.time ?? null,
  };
}

export type WeatherIcon = "sun" | "moon" | "cloud-sun" | "cloud-moon" | "cloud" | "fog" | "drizzle" | "rain" | "snow" | "thunder";

/** WMO weather interpretation codes (Open-Meteo docs) → a label key and an icon. */
export function describeWeather(code: number, isDay = true): { key: StringKey; icon: WeatherIcon } {
  if (code === 0) return { key: "weather.clear", icon: isDay ? "sun" : "moon" };
  if (code === 1) return { key: "weather.mostlyClear", icon: isDay ? "sun" : "moon" };
  if (code === 2) return { key: "weather.partlyCloudy", icon: isDay ? "cloud-sun" : "cloud-moon" };
  if (code === 3) return { key: "weather.cloudy", icon: "cloud" };
  if (code === 45 || code === 48) return { key: "weather.fog", icon: "fog" };
  if (code >= 51 && code <= 55) return { key: "weather.drizzle", icon: "drizzle" };
  if (code === 56 || code === 57 || code === 66 || code === 67) return { key: "weather.freezingRain", icon: "rain" };
  if (code >= 61 && code <= 65) return { key: "weather.rain", icon: "rain" };
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return { key: "weather.snow", icon: "snow" };
  if (code >= 80 && code <= 82) return { key: "weather.showers", icon: "rain" };
  if (code >= 95 && code <= 99) return { key: "weather.thunder", icon: "thunder" };
  return { key: "weather.unknown", icon: "cloud" };
}

export async function fetchWeather(lat: number, lon: number, fetcher: typeof fetch = fetch): Promise<Weather> {
  const res = await fetcher(weatherUrl(lat, lon));
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  const w = parseWeather(await res.json());
  if (!w) throw new Error("Open-Meteo sent no current weather");
  return w;
}
