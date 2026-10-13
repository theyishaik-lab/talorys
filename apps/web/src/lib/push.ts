import type { PushPrefs, PushSubscriptionView } from "@talorys/shared";
import { api } from "./api";

/**
 * Web Push on this device. The browser holds the subscription; the agent keeps a row per device
 * (label + per-kind preferences). Nothing here needs any third-party service: the agent Worker
 * signs and encrypts every message itself.
 */

export type PushSupport = "ok" | "no-service-worker" | "no-push" | "ios-not-installed" | "insecure";

export function pushSupport(opts: { standalone: boolean; ios: boolean }): PushSupport {
  if (typeof window === "undefined") return "no-service-worker";
  if (!window.isSecureContext) return "insecure";
  if (!("serviceWorker" in navigator)) return "no-service-worker";
  if (!("PushManager" in window) || !("Notification" in window)) return opts.ios && !opts.standalone ? "ios-not-installed" : "no-push";
  return "ok";
}

export function permissionState(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

function toKey(base64url: string): Uint8Array {
  const padded = base64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (base64url.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  if (reg) return reg;
  return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return reg ? await reg.pushManager.getSubscription() : null;
}

export async function pushConfig(): Promise<{ enabled: boolean; public_key: string | null; subscriptions: number }> {
  return await api("/push/config");
}

/** The agent's row for this browser's subscription, if it still exists. */
export async function lookupDevice(sub: PushSubscription): Promise<PushSubscriptionView | null> {
  return (await api<{ subscription: PushSubscriptionView | null }>("/push/subscriptions/lookup", { method: "POST", body: { endpoint: sub.endpoint } })).subscription;
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return `${os}${browser ? ` · ${browser}` : ""}`;
}

/** Asks for permission (must run from a tap), subscribes, and registers the device with the agent. */
export async function enablePush(publicKey: string, prefs?: Partial<PushPrefs>): Promise<{ permission: NotificationPermission; device: PushSubscriptionView | null }> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return { permission, device: null };
  const reg = await registration();
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) as BufferSource });
  const json = sub.toJSON();
  const { subscription } = await api<{ subscription: PushSubscriptionView }>("/push/subscriptions", {
    method: "POST",
    body: { endpoint: json.endpoint, keys: json.keys, label: deviceLabel(), ...(prefs ? { prefs } : {}) },
  });
  return { permission, device: subscription };
}

export async function disablePush(deviceId: string | null): Promise<void> {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe().catch(() => false);
  if (deviceId) await api(`/push/subscriptions/${deviceId}`, { method: "DELETE" }).catch(() => undefined);
}

export async function setDevicePrefs(deviceId: string, patch: Partial<PushPrefs>): Promise<PushSubscriptionView> {
  return (await api<{ subscription: PushSubscriptionView }>(`/push/subscriptions/${deviceId}`, { method: "PATCH", body: patch })).subscription;
}

export interface TestResult {
  id: string;
  label: string;
  ok: boolean;
  status: number;
  gone: boolean;
}

export async function sendTestPush(deviceId?: string): Promise<TestResult[]> {
  return (await api<{ results: TestResult[] }>("/push/test", { method: "POST", body: deviceId ? { id: deviceId } : {} })).results;
}
