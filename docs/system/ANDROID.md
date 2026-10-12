# Android app

| | |
| --- | --- |
| App name | Talorys |
| Package | `bot.tab.talorys.yishai` |
| Current version | **1.0** (versionCode **1**), built Oct 12, 2026 |
| Android | minSdk 24 (Android 7.0), targetSdk 35 |
| Source | [theyishaik-lab/talorys-android](https://github.com/theyishaik-lab/talorys-android) (private), single activity `src/bot/tab/talorys/yishai/MainActivity.java` |
| Loads | `https://talorys-lxl5w9o0-web.pages.dev/` (constant `HOME` in `MainActivity.java`) |
| Download page | https://talorys-android-yishai.sites.tab.bot (APK v1.0) |
| Signing certificate SHA-256 | `F8:54:05:4D:44:10:00:85:1D:9B:57:BD:40:C5:7C:46:55:44:DD:95:62:A6:31:A0:DA:36:C9:89:FE:A1:FC:03` |

## What it is

A full-screen WebView shell around the live web app: one login (session cookie lasts 30 days), the
back button navigates inside the app, file picker and keyboard work, SSE chat streaming works,
external links open in the system browser, dark mode follows the phone. Permissions: Internet and
network state only; cleartext HTTP is disabled; `supportsRtl="true"`.

Because it loads the live site, **every web deploy reaches the app immediately**. Rebuild the APK
only when the shell itself changes (URL, icon, name, permissions, WebView behaviour, push).

## Signing key — do not lose it

- Keystore: `talorys.jks`, alias `talorys`, plus `keystore.json` holding the store password. Both
  live only in Tab's private secret store (`state/talorys-android-keystore/`), **not in the repo**.
- Android installs an update over the existing app only if it is signed with the same key. A lost
  key means uninstalling the app (and signing in again) to install a new one.
- If you want a copy of the keystore for your own machine, ask Tab — it should travel privately,
  never through git.

## Rebuild (no Gradle, no Android Studio)

`build.sh` runs the plain SDK tools: aapt2 → javac → d8 → zipalign → apksigner.

Requirements: JDK 17, Android command-line SDK at `~/android-sdk` with `build-tools;35.0.0` and
`platforms;android-35`, and the keystore folder (path in `KS`, default Tab's secret store).

```bash
# bump BOTH numbers on every release; versionCode must always increase
VC=2 VN=1.1 ./build.sh                 # -> build/Talorys.apk (also copied to Tab's files folder)
KS=/path/to/keystore-folder VC=2 VN=1.1 ./build.sh   # on another machine
```

Check the result: `aapt dump badging build/Talorys.apk | head -3` (package + version) and
`apksigner verify --print-certs build/Talorys.apk` (the SHA-256 above).

## Release history

| Version | versionCode | Date | Notes |
| --- | --- | --- | --- |
| 1.0 | 1 | Oct 12, 2026 | First build; sent on WhatsApp + download page |

## Limits

- No push notifications (Talorys has an in-app bell only). Push would need Firebase Cloud Messaging
  in the app and a sender in the agent — see ROADMAP.md.
- Never run on an emulator (the build machine has no KVM); verified with `aapt`/`apksigner` and a
  scripted login against the live site. Real-device feedback is welcome.
- Not on Google Play; installs as a side-loaded APK ("install unknown apps" must be allowed once).
