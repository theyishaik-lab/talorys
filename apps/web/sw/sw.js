/* Talorys service worker — app shell cache, offline page, Web Push.
 *
 * Built into dist/sw.js by the `talorysServiceWorker` Vite plugin, which fills in the asset list
 * and a version hash so every deploy installs a fresh worker and drops the old cache.
 *
 * Rules:
 *  - /api/* is never touched: the agent's data is always live, never cached.
 *  - Navigations are network-first and fall back to the cached shell, then the offline page.
 *  - Hashed /assets/* are cache-first (they are immutable); icons, manifest and fonts likewise.
 */
const VERSION = "__VERSION__";
const SHELL = __SHELL__;
const CACHE = `talorys-shell-${VERSION}`;
const OFFLINE_URL = "/offline.html";
const CSRF_HEADER = "x-talorys-request";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("talorys-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return; // live data only, never cached

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put("/index.html", copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => (await caches.match("/index.html")) || (await caches.match(OFFLINE_URL)) || Response.error()),
    );
    return;
  }

  const cacheable = url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/") || url.pathname === "/manifest.webmanifest" || url.pathname === "/favicon.svg" || url.pathname === OFFLINE_URL;
  if (!cacheable) return;
  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        }),
    ),
  );
});

/** A window of the app that is open in front of the owner right now. */
async function focusedClient() {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return wins.find((w) => w.focused && w.visibilityState === "visible") || null;
}

self.addEventListener("push", (event) => {
  let data = { kind: "test", title: "Talorys", body: "", tag: "talorys", url: "/chat" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (_) {
    /* a push without JSON: show it as is */
  }
  event.waitUntil(
    (async () => {
      // Tell every open window so it refreshes (the bell, the chat with the new card).
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) w.postMessage({ type: "push", payload: data });
      // The owner is looking at the app right now: the card/bell in front of them is the notification.
      if (data.kind !== "test" && (await focusedClient())) return;
      const options = {
        body: data.body || "",
        tag: data.tag || "talorys",
        renotify: data.kind === "approval",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge-96.png",
        lang: /[\u0590-\u05FF]/.test(`${data.title} ${data.body}`) ? "he" : "en",
        dir: "auto",
        data: { url: data.url || "/chat", actionId: data.actionId || null, kind: data.kind },
        requireInteraction: data.kind === "approval",
        vibrate: data.kind === "approval" ? [60, 40, 60] : [40],
      };
      if (data.kind === "approval" && data.actions && data.actionId) {
        options.actions = [
          { action: "approve", title: "Approve · אישור" },
          { action: "decline", title: "Decline · דחייה" },
        ];
      }
      await self.registration.showNotification(data.title || "Talorys", options);
    })(),
  );
});

async function resolveAction(actionId, decision) {
  const path = decision === "approve" ? `/api/actions/${actionId}/approve` : `/api/actions/${actionId}/cancel`;
  const res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { [CSRF_HEADER]: "1", "content-type": "application/json" }, body: "{}" });
  if (!res.ok) throw new Error(`${res.status}`);
  const body = await res.json();
  return body.action?.status;
}

self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const data = notification.data || {};
  notification.close();
  event.waitUntil(
    (async () => {
      if ((event.action === "approve" || event.action === "decline") && data.actionId) {
        let title = event.action === "approve" ? "Approved ✓" : "Declined";
        let body = "";
        try {
          const status = await resolveAction(data.actionId, event.action);
          if (status === "failed") {
            title = "Approved, but it failed";
            body = "Open the app for details.";
          } else if (status === "expired") {
            title = "This approval expired";
            body = "Open the app to ask again.";
          } else if (status !== "approved" && status !== "cancelled") {
            title = "Open the app to finish";
          }
        } catch (_) {
          title = "Couldn't reach your agent";
          body = "Open the app to approve it there.";
        }
        await self.registration.showNotification(title, { body, tag: notification.tag, icon: "/icons/icon-192.png", badge: "/icons/badge-96.png", data: { url: data.url } });
        return;
      }
      const url = new URL(data.url || "/chat", self.location.origin).href;
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = wins.find((w) => "focus" in w);
      if (existing) {
        await existing.focus();
        if ("navigate" in existing) await existing.navigate(url).catch(() => {});
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});

/** The browser rotated the subscription: hand the new one to the agent. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    (async () => {
      const old = event.oldSubscription;
      const options = old ? { userVisibleOnly: true, applicationServerKey: old.options.applicationServerKey } : null;
      if (!options) return;
      const next = await self.registration.pushManager.subscribe(options);
      const json = next.toJSON();
      await fetch("/api/push/subscriptions", {
        method: "POST",
        credentials: "same-origin",
        headers: { [CSRF_HEADER]: "1", "content-type": "application/json" },
        body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, label: "" }),
      });
    })(),
  );
});
