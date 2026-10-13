# Installable app and device notifications

Since Oct 13, 2026 (branch `feat/pwa-push`), the web app is an **installable app (PWA)** and sends
**real device notifications with Web Push**, signed and encrypted by the owner's own agent Worker.
No Firebase, no Apple account, no third-party relay: each install has its own VAPID key pair.

## Installing it

| Platform | How | What you get |
| --- | --- | --- |
| Android (Chrome, Edge, Samsung Internet) | Open the site → Settings → Device notifications → **Install** (or the browser menu → "Install app") | A real launcher icon (WebAPK), full screen, its own task in Recents, notifications under the app's name, app shortcuts (New chat, Settings), icon badge |
| iPhone / iPad (iOS 16.4+) | Safari → Share → **Add to Home Screen**, then open it from the home screen | Full screen; notifications work **only** from the home-screen app, never from a Safari tab |
| Desktop (Chrome, Edge) | Address-bar install icon or Settings → Install | A window without browser chrome |

The Android WebView app (`docs/system/ANDROID.md`) is **deprecated**: a WebView has no Push API, so
it can never receive notifications. Install from Chrome instead; sign in once more (the installed
app has its own storage). The APK project stays in the repo until Yishai confirms the installed app
and its notifications work on his phone; then it goes.

## How a notification gets to the phone

```
agent proposes an action / an automation fires / an approved action finishes
  → PushService.notify(message)                      apps/agent/src/push/service.ts
      → for every subscribed device that wants this kind:
          sendPush(): RFC 8291 aes128gcm encryption (ECDH P-256 + HKDF + AES-128-GCM)
                      + RFC 8292 VAPID "Authorization: vapid t=<ES256 JWT>, k=<public key>"
                      → POST <push service endpoint>       (fcm.googleapis.com, Apple, Mozilla…)
  → the phone's push service wakes the service worker   apps/web/sw/sw.js
      → "push" event → showNotification(...)           (quiet if a window of the app is focused)
      → tap → the chat (and the approval card) opens  → Approve / Decline buttons for low-risk actions
```

All of it runs on WebCrypto (`apps/agent/src/push/webpush.ts`, ~200 lines): the Node `web-push`
package does not run on Workers. `push.test.ts` checks the encryption against the RFC 8291
Appendix A vector byte for byte. CPU per message is well under a millisecond; the VAPID JWT is
cached per push-service origin for 12 h (RFC maximum 24 h). Sends run through `ctx.waitUntil`, so
a chat turn never waits for a push service.

### What triggers a push

| Kind | When | Default |
| --- | --- | --- |
| `approval` | the agent proposed an action or a connection (an Approve card) in a chat — `ToolExecutor` in `tools/registry.ts` | on |
| `result` | the bell got a "Done" / "Connected" notification after an approval (`kind: "result"` on `notifications.create`) | on |
| `reminder` | anything else that lands in the bell: reminders, task digests, scheduled AI runs, `notify_owner` | on |

Each device keeps its own on/off per kind (`prefs` JSON on its row). A test message (`kind: "test"`)
ignores the preferences.

**Quiet when you are looking:** the service worker checks `clients.matchAll()`; if a window of the
app is focused and visible, the push only refreshes the page (the bell, the chat) and shows nothing —
so an approval that appears while you are typing never also rings the phone. Chrome allows skipping
the notification exactly in that case.

**Approve from the notification:** only for low-risk additions (`isLowRiskAction()` in
`push/service.ts`: `*.insert_task`, `*.create_event`, `notion.create_page`, `github.create_issue`…).
Sending mail, deleting, paying, sharing, connecting an app, and every upstream destructive tool
(delete task/note) get no buttons: the tap opens the full card in the app. The buttons call
`POST /api/actions/:id/approve|cancel` from the service worker with the session cookie + CSRF header
(same origin), then show a one-line follow-up ("Approved ✓", "Declined", "Approved, but it failed").
iOS shows no action buttons at all.

### Storage

`tal_push_subscriptions` (migration 6): `id, endpoint (unique), p256dh, auth, label, prefs, created_at,
last_used_at, failures`. A 404/410 from the push service deletes the row; 8 consecutive failures too;
the 20 newest devices are kept. The endpoint and keys never leave the agent (the API returns id,
label, prefs only). Backups (`/api/export`) do not include push subscriptions — devices re-enable.

### API (session + CSRF header, like everything under /api)

| Route | What |
| --- | --- |
| `GET /api/push/config` | `{ enabled, public_key, subscriptions }` — `enabled` is false without VAPID keys |
| `POST /api/push/subscriptions` | `{ endpoint, keys: { p256dh, auth }, label?, prefs? }` → upsert by endpoint → `{ subscription }` |
| `POST /api/push/subscriptions/lookup` | `{ endpoint }` → this browser's row, or null |
| `PATCH /api/push/subscriptions/:id` | `{ approval?, result?, reminder? }` |
| `DELETE /api/push/subscriptions/:id` | forget a device |
| `POST /api/push/test` | `{ id? }` → sends now, returns each push service's answer |

### Secrets (SECRETS.md)

`VAPID_PUBLIC_KEY` (65-byte P-256 point, base64url), `VAPID_PRIVATE_KEY` (32-byte scalar, base64url),
`VAPID_SUBJECT` (`mailto:` contact). The installer generates them per install
(`packages/create-talorys/src/secrets.ts`, `generateVapidKeys()`); for Yishai's Worker they were set
on Oct 13, 2026 and a copy sits in Tab's secret store. **Never rotate the private key casually** —
every subscribed device would have to enable notifications again.

## The service worker (`apps/web/sw/sw.js` → `dist/sw.js`)

Built by the `talorysServiceWorker` plugin in `apps/web/vite.config.ts`, which fills in the list of
shell files (index.html, hashed assets, fonts, icons, manifest, offline page) and a version hash of
the build. Rules:

- `/api/*` is **never** intercepted: the agent's data is always live.
- Navigations are network-first; offline they get the cached `index.html` (the app shell, which then
  says it cannot reach the agent) or `offline.html`.
- `/assets/*` (immutable), `/icons/*`, the manifest and fonts are cache-first.
- A new build = a new cache name; the old one is deleted on activate; `skipWaiting` + `clients.claim`
  so the new worker takes over on the next load. `/sw.js` and the manifest are served `no-cache`
  (`public/_headers`); the CSP has `worker-src 'self'; manifest-src 'self'`.
- `pushsubscriptionchange` re-subscribes and re-registers with the agent.

The manifest is `public/manifest.webmanifest` (standalone, `start_url: /chat?source=pwa`, icons
192/512 + maskable + monochrome, shortcuts). Icons are generated PNGs in `public/icons/` (the "T"
mark in the placeholder accent; regenerate them when the brand is chosen). `index.html` carries the
iOS meta tags and the apple-touch-icon.

Client side: `src/lib/pwa.ts` (registration, `beforeinstallprompt`, standalone/iOS detection,
messages from the worker) and `src/lib/push.ts` (subscribe / unsubscribe / prefs / test). Settings →
"Device notifications" is `src/components/DeviceNotifications.tsx`. A push received while the app is
open invalidates the notifications and conversation queries (`main.tsx`).

## Limits and things to know

- **iOS**: notifications only from the home-screen app (iOS 16.4+); no action buttons; no silent
  pushes; permission is asked from a tap inside the installed app; Focus modes apply.
- **Android WebView** (the old APK): no push, ever. **Firefox Android**: push works from the browser.
- A push payload is kept under 1 KB (title, one line of body, tag, url, action id).
- Chrome shows "This site has been updated in the background" if a push shows no notification while
  no window is focused — the worker always shows one in that case.
- Free plan: pushes are a few hundred microseconds of CPU each; the push service calls are I/O.

## Verified (Oct 13, 2026)

Headless Chrome (full Chromium, persistent profile — Chrome has no Push API in incognito) against
the live Pages preview: manifest valid and installable (Chrome fired `beforeinstallprompt`), service
worker active and controlling, a real subscription on Google's push service, a test push from the
agent Worker received by the worker and displayed within a second, offline navigation served from
the cached shell. Script: Tab's task folder (`e2e/push-e2e.mjs`).
