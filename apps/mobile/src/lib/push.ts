import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { ApiError, api } from "./api";

/**
 * Native push (Firebase Cloud Messaging) registered with the person's own agent Worker.
 * Mirrors the Web Push flow in apps/web/src/lib/push.ts: the agent keeps one row per device.
 */
export interface PushDeviceView {
  id: string;
  label: string;
  platform: "android" | "ios";
  prefs: { approval: boolean; result: boolean; reminder: boolean };
  created_at: string;
  last_used_at: string | null;
  failures: number;
}

export interface NativePushConfig {
  enabled: boolean;
  devices: PushDeviceView[];
}

const DEVICE_KEY = "talorys.push.device";

export const CHANNELS = {
  approvals: { id: "approvals", name: "Approvals", importance: Notifications.AndroidImportance.HIGH },
  updates: { id: "updates", name: "Updates", importance: Notifications.AndroidImportance.DEFAULT },
} as const;

export async function ensureChannels(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(CHANNELS.approvals.id, { name: CHANNELS.approvals.name, importance: CHANNELS.approvals.importance, vibrationPattern: [0, 200, 100, 200], lightColor: "#4C47E0" });
  await Notifications.setNotificationChannelAsync(CHANNELS.updates.id, { name: CHANNELS.updates.name, importance: CHANNELS.updates.importance });
}

export type PermissionState = "granted" | "denied" | "undetermined";

export async function permissionState(): Promise<PermissionState> {
  const p = await Notifications.getPermissionsAsync();
  if (p.granted) return "granted";
  return p.canAskAgain ? "undetermined" : "denied";
}

export async function storedDeviceId(): Promise<string | null> {
  return AsyncStorage.getItem(DEVICE_KEY);
}

/** Asks for permission (a real device only), gets the FCM token, registers it with the agent. */
export async function registerForPush(options: { ask?: boolean } = {}): Promise<{ state: PermissionState; device: PushDeviceView | null; reason?: string }> {
  if (!Device.isDevice) return { state: "denied", device: null, reason: "not-a-device" };
  await ensureChannels();
  let state = await permissionState();
  if (state === "undetermined" && options.ask) {
    const p = await Notifications.requestPermissionsAsync();
    state = p.granted ? "granted" : p.canAskAgain ? "undetermined" : "denied";
  }
  if (state !== "granted") return { state, device: null };
  let token: string;
  try {
    token = (await Notifications.getDevicePushTokenAsync()).data as string;
  } catch (error) {
    return { state, device: null, reason: error instanceof Error ? error.message : "no-token" };
  }
  try {
    const { device } = await api<{ device: PushDeviceView }>("/push/devices", {
      method: "POST",
      body: { token, platform: Platform.OS, label: `${Device.manufacturer ?? ""} ${Device.modelName ?? "Android"}`.trim().slice(0, 80) },
    });
    await AsyncStorage.setItem(DEVICE_KEY, device.id);
    return { state, device };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return { state, device: null, reason: "agent-no-native-push" };
    throw error;
  }
}

export async function unregisterPush(): Promise<void> {
  const id = await storedDeviceId();
  if (!id) return;
  await AsyncStorage.removeItem(DEVICE_KEY);
  await api(`/push/devices/${id}`, { method: "DELETE" }).catch(() => {});
}

export async function pushConfig(): Promise<NativePushConfig | null> {
  try {
    return await api<NativePushConfig>("/push/native");
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export async function updatePrefs(id: string, prefs: Partial<PushDeviceView["prefs"]>): Promise<PushDeviceView> {
  const { device } = await api<{ device: PushDeviceView }>(`/push/devices/${id}`, { method: "PATCH", body: prefs });
  return device;
}

export async function sendTest(id: string): Promise<{ ok: boolean; results: { id: string; status: number | string; error?: string }[] }> {
  return api("/push/devices/test", { method: "POST", body: { id } });
}

/** Where a notification tap should land (kept here for existing imports; the logic is pure and tested). */
export { targetOf } from "./notificationRouting";
