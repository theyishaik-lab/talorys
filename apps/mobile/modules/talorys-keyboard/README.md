# Talorys Keyboard (Expo local module, Android only)

The Android keyboard that ships inside the Talorys app (`dev.talorys.app`) since mobile **0.4.0**.
It was the separate app `com.talorys.keyboard` (repo `yishaik/talorys-keyboard`, last release
v1.4.1, commit `735f04a`); its code moved here unchanged except where noted below.

## What is here

| Path | What |
| --- | --- |
| `android/src/main/java/com/talorys/keyboard/**` | The keyboard, Kotlin package names kept: IME (`TalorysInputMethodService`), keys / strip / panels (`keyboard/`), suggestion engine, spatial model, swipe decoder, bigrams, learned words, Hebrew prefixes (`suggest/`), encrypted clipboard history (`clip/`), opt-in screen-word learning (`screen/`), Ask sheet + device assistant (`ChatActivity`, `AssistActivity`), accessibility context service, companion polling service, dictionary backup (`DictionarySync`, GET/PUT `/api/keyboard/dictionary`). |
| `.../KeyboardBridge.kt` | Everything Settings → Keyboard reads and writes (no Expo types, unit-tested). |
| `.../expo/TalorysKeyboardModule.kt` | The Expo module `TalorysKeyboard` (JS side typed in `index.ts`). |
| `.../AppLink.kt` | Opens app routes (`talorys://settings/keyboard`); `KeyboardSettingsActivity` is the no-UI target of the system "keyboard settings" gear. |
| `android/src/main/assets/dict/` | 100K English / 140K Hebrew word lists and next-word pairs (see Licences). |
| `android/src/main/res/` | Layouts, drawables, strings (EN + `values-iw`), IME and accessibility XML. Every resource is prefixed `tk_` so it never clashes with the app's or another library's. |
| `android/src/main/AndroidManifest.xml` | Merged into the app: IME service, accessibility service, companion service, Ask sheet, device assistant, settings trampoline, permissions. |
| `android/src/test/` | The keyboard's 109 unit tests (JUnit + Robolectric) plus the bridge test. |

## What changed from the standalone app

- **One login.** No URL / token form. The app pushes its session to the keyboard through
  `TalorysKeyboard.setSession(server, token)` on start-up, sign-in, sign-out and 401
  (`src/lib/keyboardBridge.ts`); the keyboard keeps it in its encrypted preferences
  (`EncryptedSharedPreferences`, Android Keystore) and calls `{server}/api/...`.
- **Settings in React Native.** `SettingsActivity` and `ScreenWordsActivity` are gone; the app's
  Settings → Keyboard (`src/app/settings/keyboard*.tsx`) replaces them. Preferences stay in the
  keyboard's SharedPreferences (`talorys_ui`), so the IME reads every change live.
- The Ask sheet's "Open settings" / 401 hint now open the Talorys app (sign in there).
- `TalorysApp` (Application) is gone: the app's own Application runs; Material You colours are
  applied per activity.
- Screen learning never reads `dev.talorys.app` (nor the old `com.talorys.keyboard`).
- Built with the app's toolchain (Kotlin 2.1.20, AGP 8.12, compileSdk 36) instead of the
  standalone app's (Kotlin 2.4, AGP 9.1, compileSdk 37); kotlinx-serialization-json 1.8.1.

## Tests

From a prebuilt project (`npx expo prebuild --platform android`):

```bash
cd android && ./gradlew :talorys-keyboard:testDebugUnitTest
```

## Licences of the word lists

`en.txt` / `he.txt` are redistributed under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)
with attribution to [wordfreq](https://github.com/rspeer/wordfreq) (Robyn Speer),
[Hermit Dave / FrequencyWords](https://github.com/hermitdave/FrequencyWords) and the OpenSubtitles
corpus, and [SCOWL](http://wordlist.aspell.net/) (Kevin Atkinson, permissive licence; used as an
English spelling filter). `en.bigrams.txt` / `he.bigrams.txt` are under CC BY 2.0 FR with
attribution to [Tatoeba](https://tatoeba.org) and its contributors. How they were built:
`tools/dict/build_dicts.py` in `yishaik/talorys-keyboard`.
