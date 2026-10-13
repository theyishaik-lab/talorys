# Installable app and device notifications

Since Oct 13, 2026 (agent 0.1.6-push), the web app is an **installable app (PWA)** and sends
**real device notifications with Web Push**, signed and encrypted by the owner's own agent Worker.
No Firebase, no Apple account, no third-party relay: each install has its own VAPID key pair.

## Installing it

| Platform | How | What you get |
| --- | --- | --- |
| Android (Chrome, Edge, Samsung Internet) | Open the site → Settings → Device notifications → **Install** (or the browser menu → "Install app") | A real launcher icon (WebAPK), full screen, its own task in Recents, notifications under the app's name, app shortcuts (New chat, Settings), icon badge |
| iPhone / iPad (iOS 16.4+) | Safari → Share → **Add to Home Screen**, then open it from the home screen | Full screen; notifications work **only** from the home-screen app, never from a Safari tab |
| Desktop (Chrome, Edge) | Address-bar install icon or Settings → Install | A window without browser chrome |

The **native Android app** (`docs/system/MOBILE.md`) gets its notifications through Firebase Cloud
Messaging instead — see "Native push" at the end. The first, WebView-based APK (no Push API) was
retired on Oct 13, 2026 and its source, key and download page deleted.

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

### What the section shows (Oct 13, 2026, `34ded0e`, `0c75a3f`)

- **State panel**: where it runs (browser tab / installed app / an Android WebView), permission
  (not asked yet / allowed / blocked), registered with the agent yes/no, last test result with the push
  service's HTTP status (Google answers 201 when it accepted the message).
- A failed enable names the step that failed (permission, service worker, subscribe, server) in Hebrew
  with what to do; while blocked there is a **Retry** button and the Android path
  (Settings → Apps → Chrome/Talorys → Notifications → Allow; Chrome → Site settings → Notifications).
- The state is read again when the app comes back to the foreground (after changing Android settings).
- `Notification.requestPermission()` is the first await in the tap handler, so the prompt keeps the
  user gesture in the installed PWA on Android Chrome.

Diagnosis on Yishai's phone (Oct 13, 13:15 IL): his agent had **zero** subscriptions — his device never
finished subscribing (the old WebView APK has no Push API, or Chrome quieted the permission prompt).

## Limits and things to know

- **iOS**: notifications only from the home-screen app (iOS 16.4+); no action buttons; no silent
  pushes; permission is asked from a tap inside the installed app; Focus modes apply.
- **Android WebView**: no Push API, ever. **Firefox Android**: push works from the browser.
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

Oct 13, 2026 ~14:30 IL, production, headless Chromium (Pixel UA, Hebrew): the three permission states
render correctly (not asked / blocked with guidance + Retry / allowed); enable → subscribed, registered
"yes"; "send test" → "delivered (201)"; the test device was then removed (0 subscriptions left).
Screenshots: Tab's files `talorys-notif-fix-prod-*.png`.

## Native push (the Android app)

`apps/mobile` registers its FCM device token (`POST /api/push/devices`, `tal_push_devices`,
migration 8) and the agent sends through **FCM HTTP v1** from the Worker
(`apps/agent/src/push/fcm.ts`): a service-account JWT signed with WebCrypto (RS256), an OAuth
access token cached for 55 minutes, one `messages:send` per device. `PushService.notify()` fans
every message out to both channels, so the triggers and the three kinds above are identical; each
phone keeps its own toggles. A 404 / `UNREGISTERED` from FCM deletes the device row.

| Route | What |
| --- | --- |
| `GET /api/push/native` | `{ enabled, devices }` — enabled when the Worker has `FCM_SERVICE_ACCOUNT` |
| `POST /api/push/devices` | `{ token, platform, label?, prefs? }` → upsert by token → `{ device }` |
| `PATCH /api/push/devices/:id` | `{ approval?, result?, reminder? }` |
| `DELETE /api/push/devices/:id` | forget a phone |
| `POST /api/push/devices/test` | `{ id? }` → sends now, returns FCM's answer (`name` on success) per phone |

Secrets: `FCM_SERVICE_ACCOUNT` (the service-account JSON, verbatim; SECRETS.md) and the optional
`PUBLIC_APP_URL` var. Android channels `approvals` (high) and `updates` (default); a tap opens the
chat in `data.conversation_id`. Approve/Decline buttons on the tray notification are not there yet
(MOBILE.md).

### Status on this install (Oct 13, 2026, agent `0.1.10-fcm`)

Live. Firebase project **`talorys-app`** (Spark plan, no billing, Analytics and Gemini off) on the
owner's Google account — deliberately *not* added to `talorys-connector`, whose billing account would
have put Firebase on the pay-as-you-go Blaze plan (irreversible). Android app `dev.talorys.app`
registered; `FCM_SERVICE_ACCOUNT` = the project's `firebase-adminsdk-fbsvc@…` key; `PUBLIC_APP_URL`
set so `data.url` is absolute. `GET /api/push/native` → `enabled: true`.

Verified end to end without a phone: a node FCM client (`@eneris/push-receiver`, holding a genuine
registration token for `talorys-app`) was registered through `POST /api/push/devices`, then
`POST /api/push/devices/test` answered `200` with `name: projects/talorys-app/messages/95e5aa47-…`
and the client received that exact message (title, body, `data.url`) 0.3 s later; a second send after
the `PUBLIC_APP_URL` deploy carried the absolute URL. The test row was deleted afterwards. The
first real phone is the owner's, with APK `native-v0.1.1` (versionCode 3, `google-services.json`
baked in) — a notification shown in the Android tray has not been seen by Tab.
