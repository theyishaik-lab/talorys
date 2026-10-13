/**
 * The installed-app side of the web app: service worker registration, the Android install prompt,
 * and the facts the Settings page shows (is this already the installed app, is this an iPhone).
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

/** Running as an installed app (home-screen icon, no browser chrome). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

export function isIOS(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/** Whether Chrome (Android/desktop) offered its install prompt and we can show it on a tap. */
export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

export function onInstallAvailable(fn: () => void): () => void {
  installListeners.add(fn);
  return () => installListeners.delete(fn);
}

/** Shows the browser's install dialog. Resolves to the outcome, or null when no prompt is available. */
export async function promptInstall(): Promise<"accepted" | "dismissed" | null> {
  const ev = deferredPrompt;
  if (!ev) return null;
  deferredPrompt = null;
  await ev.prompt();
  const { outcome } = await ev.userChoice;
  for (const fn of installListeners) fn();
  return outcome;
}

export type SwMessage = { type: "push"; payload: { kind: string; url?: string; actionId?: string } };
const swListeners = new Set<(m: SwMessage) => void>();
export function onServiceWorkerMessage(fn: (m: SwMessage) => void): () => void {
  swListeners.add(fn);
  return () => swListeners.delete(fn);
}

/** Registers /sw.js in production and wires the install prompt. Safe to call once at startup. */
export function initPwa(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    for (const fn of installListeners) fn();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    for (const fn of installListeners) fn();
  });
  if (!("serviceWorker" in navigator) || !import.meta.env.PROD) return;
  navigator.serviceWorker.addEventListener("message", (e) => {
    const m = e.data as SwMessage | undefined;
    if (m && typeof m === "object" && m.type === "push") for (const fn of swListeners) fn(m);
  });
  // A new deploy installs a new worker (skipWaiting + claim). The open app keeps running the old
  // build until it reloads; like a native app it does that quietly the next time it is in the
  // background (never under the owner's fingers), or at once when it is already hidden.
  const hadController = !!navigator.serviceWorker.controller;
  let updated = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || updated) return;
    updated = true;
    if (document.visibilityState === "hidden") window.location.reload();
    else document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && window.location.reload(), { once: true });
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/" })
      .then((reg) => {
        // Check for a newer build whenever the app comes back to the foreground.
        document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && reg.update().catch(() => {}));
      })
      .catch((error) => console.warn("service worker registration failed", error));
  });
}
