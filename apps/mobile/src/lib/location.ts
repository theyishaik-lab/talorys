import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";

/**
 * The phone's approximate location for the Home weather card. Android's permission prompt is shown
 * once, from the card's own button (never on launch); after that the card reads the state and,
 * when denied, says how to turn it on instead of asking again.
 */
const ASKED_KEY = "talorys.location.asked";

export type LocationState = "granted" | "denied" | "undetermined";

export async function locationState(): Promise<LocationState> {
  const p = await Location.getForegroundPermissionsAsync();
  if (p.granted) return "granted";
  const asked = (await AsyncStorage.getItem(ASKED_KEY)) === "1";
  return asked || !p.canAskAgain ? "denied" : "undetermined";
}

/** Shows Android's prompt (once). */
export async function askForLocation(): Promise<LocationState> {
  await AsyncStorage.setItem(ASKED_KEY, "1");
  const p = await Location.requestForegroundPermissionsAsync();
  return p.granted ? "granted" : "denied";
}

/** A coarse position: the last known one when it is recent, else a fresh low-accuracy fix. */
export async function approximatePosition(): Promise<{ lat: number; lon: number }> {
  const last = await Location.getLastKnownPositionAsync({ maxAge: 30 * 60_000 }).catch(() => null);
  if (last) return { lat: last.coords.latitude, lon: last.coords.longitude };
  const fix = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("location timeout")), 15_000)),
  ]);
  return { lat: fix.coords.latitude, lon: fix.coords.longitude };
}

/** The place name for the card, when Android's geocoder knows it. */
export async function placeName(lat: number, lon: number): Promise<string | null> {
  try {
    const [p] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
    return p?.city ?? p?.subregion ?? p?.region ?? null;
  } catch {
    return null;
  }
}
