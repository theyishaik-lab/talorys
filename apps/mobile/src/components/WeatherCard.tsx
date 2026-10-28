import { Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudMoon, CloudRain, CloudSnow, CloudSun, type LucideIcon, MapPin, Moon, Sun } from "lucide-react-native";
import { memo, useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { type LocationState, approximatePosition, askForLocation, locationState, placeName } from "../lib/location";
import { useTheme } from "../lib/theme";
import { type Weather, type WeatherIcon, describeWeather, fetchWeather } from "../lib/weather";
import { Button, Card, Icon, T } from "./ui";

const ICONS: Record<WeatherIcon, LucideIcon> = {
  sun: Sun,
  moon: Moon,
  "cloud-sun": CloudSun,
  "cloud-moon": CloudMoon,
  cloud: Cloud,
  fog: CloudFog,
  drizzle: CloudDrizzle,
  rain: CloudRain,
  snow: CloudSnow,
  thunder: CloudLightning,
};

type View_ = { state: "loading" } | { state: "ask" } | { state: "denied" } | { state: "error" } | { state: "ok"; weather: Weather; place: string | null };

/**
 * Current conditions plus today's high / low for where the phone is (Open-Meteo, no key). The
 * location prompt is shown once, from the Allow button; denied → how to turn it on, never a re-ask.
 * `refreshKey` changes on pull-to-refresh.
 */
export const WeatherCard = memo(function WeatherCard({ refreshKey }: { refreshKey: number }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const [view, setView] = useState<View_>({ state: "loading" });

  const load = useCallback(async (perm?: LocationState) => {
    try {
      const state = perm ?? (await locationState());
      if (state === "undetermined") return setView({ state: "ask" });
      if (state === "denied") return setView({ state: "denied" });
      const { lat, lon } = await approximatePosition();
      const [weather, place] = await Promise.all([fetchWeather(lat, lon), placeName(lat, lon)]);
      setView({ state: "ok", weather, place });
    } catch {
      setView({ state: "error" });
    }
  }, []);

  useEffect(() => {
    void refreshKey;
    Promise.resolve().then(() => load());
  }, [load, refreshKey]);

  if (view.state === "loading") {
    return (
      <Card style={{ minHeight: 84, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator color={c.fgMuted} />
      </Card>
    );
  }
  if (view.state === "ask") {
    return (
      <Card style={{ gap: 10 }}>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <Icon icon={CloudSun} size={22} color={c.accentText} />
          <T weight="medium" style={{ flex: 1 }}>
            {t("weather.enable")}
          </T>
        </View>
        <T size={13} muted>
          {t("weather.enableHint")}
        </T>
        <Button title={t("weather.allow")} small variant="secondary" icon={MapPin} style={{ alignSelf: "flex-start" }} onPress={async () => load(await askForLocation())} />
      </Card>
    );
  }
  if (view.state === "denied" || view.state === "error") {
    return (
      <Card style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <Icon icon={Cloud} size={20} color={c.fgMuted} />
          <T size={13} muted style={{ flex: 1 }}>
            {view.state === "denied" ? t("weather.denied") : t("weather.failed")}
          </T>
        </View>
        {view.state === "denied" ? (
          <Button title={t("weather.openSettings")} small variant="ghost" style={{ alignSelf: "flex-start" }} onPress={() => Linking.openSettings().catch(() => {})} />
        ) : (
          <Button title={t("common.retry")} small variant="ghost" style={{ alignSelf: "flex-start" }} onPress={() => load()} />
        )}
      </Card>
    );
  }
  const { weather, place } = view;
  const d = describeWeather(weather.code, weather.isDay);
  return (
    <Card style={{ flexDirection: "row", alignItems: "center", gap: 14 }} accent>
      <Icon icon={ICONS[d.icon]} size={40} color={c.accentText} strokeWidth={1.5} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
          <T weight="semibold" size={30} style={{ lineHeight: 36 }}>
            {Math.round(weather.temperature)}°
          </T>
          <T size={15}>{t(d.key)}</T>
        </View>
        <T size={13} muted numberOfLines={1}>
          {[place ?? t("weather.here"), weather.high !== null && weather.low !== null ? t("weather.highLow", { high: Math.round(weather.high), low: Math.round(weather.low) }) : null]
            .filter(Boolean)
            .join(" · ")}
        </T>
        {weather.apparentTemperature !== null && Math.round(weather.apparentTemperature) !== Math.round(weather.temperature) ? (
          <T size={12} muted>
            {t("weather.feels", { temp: Math.round(weather.apparentTemperature) })}
          </T>
        ) : null}
      </View>
    </Card>
  );
});
