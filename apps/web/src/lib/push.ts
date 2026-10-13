import type { PushPrefs, PushSubscriptionView } from "@talorys/shared";
import { fromBase64Url } from "@talorys/shared/crypto";
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

/** The old Android WebView app (`; wv)` in Chrome's UA): no Push API, ever. */
export function isAndroidWebView(): boolean {
  return typeof navigator !== "undefined" && /Android/.test(navigator.userAgent) && /; wv\)/.test(navigator.userAgent);
}

/** Where the enable flow stopped, so the UI can say what to do. */
export type PushStep = "permission" | "service-worker" | "subscribe" | "server";
export class PushEnableError extends Error {
  constructor(
    readonly step: PushStep,
    readonly permission: NotificationPermission,
    message: string,
  ) {
    super(message);
    this.name = "PushEnableError";
  }
}

export interface LastTest {
  at: string;
  ok: boolean;
  status: number;
}
const LAST_TEST_KEY = "talorys.push.lastTest";
export function readLastTest(): LastTest | null {
  try {
    const raw = localStorage.getItem(LAST_TEST_KEY);
    return raw ? (JSON.parse(raw) as LastTest) : null;
  } catch {
    return null;
  }
}
export function writeLastTest(result: LastTest): void {
  try {
    localStorage.setItem(LAST_TEST_KEY, JSON.stringify(result));
  } catch {
    /* storage unavailable */
  }
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

/**
 * Asks for permission (must run from a tap), subscribes, and registers the device with the agent.
 * Every step that can fail throws a `PushEnableError` naming the step: "permission" when the
 * prompt was blocked or closed, "service-worker" when none is active, "subscribe" when the
 * browser could not register with its push service, "server" when the agent refused the row.
 */
export async function enablePush(publicKey: string, prefs?: Partial<PushPrefs>): Promise<{ permission: NotificationPermission; device: PushSubscriptionView }> {
  let permission: NotificationPermission;
  try {
    permission = await Notification.requestPermission();
  } catch (error) {
    throw new PushEnableError("permission", Notification.permission, String(error));
  }
  if (permission !== "granted") throw new PushEnableError("permission", permission, permission);
  let reg: ServiceWorkerRegistration;
  try {
    reg = await registration();
    await withTimeout(navigator.serviceWorker.ready, 15_000);
  } catch (error) {
    throw new PushEnableError("service-worker", permission, String(error));
  }
  let sub: PushSubscription | null;
  try {
    sub = await reg.pushManager.getSubscription();
    // A subscription made with another install's key cannot be reused: start over.
    if (sub?.options.applicationServerKey && !sameKey(sub.options.applicationServerKey, publicKey)) {
      await sub.unsubscribe().catch(() => false);
      sub = null;
    }
    if (!sub) sub = await withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(publicKey) as BufferSource }), 20_000);
  } catch (error) {
    throw new PushEnableError("subscribe", permission, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  }
  const json = sub.toJSON();
  try {
    const { subscription } = await api<{ subscription: PushSubscriptionView }>("/push/subscriptions", {
      method: "POST",
      body: { endpoint: json.endpoint, keys: json.keys, label: deviceLabel(), ...(prefs ? { prefs } : {}) },
    });
    return { permission, device: subscription };
  } catch (error) {
    throw new PushEnableError("server", permission, error instanceof Error ? error.message : String(error));
  }
}

function sameKey(stored: ArrayBuffer | ArrayBufferView, publicKey: string): boolean {
  const a = stored instanceof ArrayBuffer ? new Uint8Array(stored) : new Uint8Array(stored.buffer, stored.byteOffset, stored.byteLength);
  const b = fromBase64Url(publicKey);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
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
