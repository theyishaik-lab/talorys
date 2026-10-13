#!/bin/bash
# Builds a signed release APK locally (no EAS, no cloud). Needs: Node 22, JDK 17, Android SDK with
# platform 36, build-tools 36.0.0, NDK 27.1.12297006 and cmake 3.22.1 (ANDROID_HOME set).
#
# Signing: export TALORYS_KEYSTORE_PATH / TALORYS_KEYSTORE_PASSWORD (/ TALORYS_KEY_ALIAS,
# TALORYS_KEY_PASSWORD) — see docs/system/MOBILE.md. Without them the APK is debug-signed.
# Native push: drop the Firebase google-services.json next to this script's parent (apps/mobile/)
# before running; it is gitignored and picked up by the googleServicesFile setting in app.json.
set -euo pipefail
cd "$(dirname "$0")/.."
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
npx expo prebuild --platform android --no-install --clean
# A phone-only build: arm64 keeps the APK small and the native compile short. Add armeabi-v7a for old phones.
sed -i 's/^reactNativeArchitectures=.*/reactNativeArchitectures=arm64-v8a/' android/gradle.properties
# Gentle on memory (the first native compile is heavy); lintVital is skipped — `expo lint` + tsc run in CI instead.
sed -i 's/^org.gradle.jvmargs=.*/org.gradle.jvmargs=-Xmx1536m -XX:MaxMetaspaceSize=512m -XX:+UseParallelGC/' android/gradle.properties
printf 'org.gradle.workers.max=2\nkotlin.daemon.jvmargs=-Xmx1024m\n' >> android/gradle.properties
cd android
./gradlew assembleRelease -x lintVitalAnalyzeRelease -x lintVitalReportRelease -x lintVitalRelease --no-daemon --console=plain
ls -la app/build/outputs/apk/release/app-release.apk
