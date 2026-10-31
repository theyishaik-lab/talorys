/**
 * Talorys Keyboard — the Android input method that ships inside the Talorys app (Expo local module).
 *
 * The keyboard itself (keys, suggestion strip, Ask sheet) is native. This file is the typed JS side
 * of its bridge: the app hands it the session (one login), and the Settings → Keyboard screen reads
 * and writes its preferences, which live in the keyboard's SharedPreferences so the IME picks every
 * change up live. Android only: on other platforms `TalorysKeyboard` is null.
 */
import { Platform } from "react-native";
import { requireOptionalNativeModule } from "expo";

export type KeyboardTheme = "system" | "light" | "dark";
/** "" follows the system keyboard language (subtype); otherwise the layout the keyboard opens with. */
export type KeyboardLanguage = "" | "en" | "he";
/** 0 off, -1 left, 1 right. */
export type OneHanded = -1 | 0 | 1;

export interface KeyboardPreferences {
  keyHeightDp: number;
  theme: KeyboardTheme;
  dynamicColor: boolean;
  language: KeyboardLanguage;
  oneHanded: OneHanded;
  wordSuggestions: boolean;
  autocorrect: boolean;
  emojiSuggestions: boolean;
  swipe: boolean;
  keyPreviews: boolean;
  showHints: boolean;
  /** 0 (off) … 5. */
  hapticStrength: number;
  hapticSystem: boolean;
  sound: boolean;
  /** 0 … 1. */
  soundVolume: number;
  clipboardHistory: boolean;
  /** One of `KeyboardConstants.clipboardExpiryChoices`; 0 = never. */
  clipboardExpiryMs: number;
  /** Back up learned words to the agent (GET/PUT /api/keyboard/dictionary). */
  cloudBackup: boolean;
  screenLearning: boolean;
  screenBackup: boolean;
  /** Foreground companion that keeps agent suggestions fresh (needs the notification permission). */
  alwaysOn: boolean;
}

export interface KeyboardConstants {
  keyHeightPresets: number[];
  minKeyHeight: number;
  maxKeyHeight: number;
  defaultKeyHeight: number;
  clipboardExpiryChoices: number[];
  defaultExcludedApps: string[];
  dynamicColorAvailable: boolean;
}

export interface KeyboardStatus {
  keyboardEnabled: boolean;
  keyboardSelected: boolean;
  accessibilityEnabled: boolean;
  defaultAssistant: boolean;
  /** The keyboard holds the app's session. */
  signedIn: boolean;
  /** False only when the Android Keystore was unavailable (token kept in app-private prefs). */
  credentialsEncrypted: boolean;
}

export interface DictionaryStatus {
  learnedWords: number;
  /** Epoch ms of the last successful backup sync; 0 = never. */
  lastSync: number;
  backupEnabled: boolean;
  signedIn: boolean;
}

export interface ScreenWord {
  word: string;
  lang: string;
  count: number;
  lastSeen: number;
}

export interface ScreenWords {
  words: ScreenWord[];
  total: number;
  matching: number;
  pending: number;
}

export interface ClipItem {
  id: number;
  text: string;
  time: number;
  pinned: boolean;
}

export interface TalorysKeyboardNative {
  setSession(server: string | null, token: string | null): void;
  getConstants(): KeyboardConstants;
  getStatus(): KeyboardStatus;
  openInputMethodSettings(): boolean;
  showInputMethodPicker(): boolean;
  openAccessibilitySettings(): boolean;
  openAssistantSettings(): boolean;
  getPreferences(): KeyboardPreferences;
  setPreferences(values: Partial<KeyboardPreferences>): KeyboardPreferences;
  getDictionaryStatus(): DictionaryStatus;
  clearLearnedWords(): void;
  syncDictionary(): Promise<DictionaryStatus>;
  restoreDictionary(): Promise<DictionaryStatus>;
  getScreenWords(query: string): ScreenWords;
  deleteScreenWord(lang: string, word: string): boolean;
  clearScreenWords(): void;
  getExcludedApps(): string[];
  /** null restores the default list. Returns the saved (validated) list. */
  setExcludedApps(apps: string[] | null): string[];
  getClipboard(): ClipItem[];
  deleteClip(id: number): boolean;
  pinClip(id: number, pinned: boolean): boolean;
  clearClipboard(includePinned: boolean): void;
}

/** The native module, or null where it does not exist (iOS, web, Expo Go). */
export const TalorysKeyboard: TalorysKeyboardNative | null =
  Platform.OS === "android" ? requireOptionalNativeModule<TalorysKeyboardNative>("TalorysKeyboard") : null;

export const isKeyboardAvailable = (): boolean => TalorysKeyboard != null;
