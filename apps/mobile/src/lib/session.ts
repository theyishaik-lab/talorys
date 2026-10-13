import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

/**
 * Where this phone's Talorys lives and the session token that proves it is the owner's phone.
 * The token sits in the Android keystore-backed SecureStore; the server address in plain storage.
 */
const TOKEN_KEY = "talorys.session";
const SERVER_KEY = "talorys.server";

const DEFAULT_SERVER: string = (Constants.expoConfig?.extra as { defaultServer?: string } | undefined)?.defaultServer ?? "";

let token: string | null = null;
let server: string = DEFAULT_SERVER;
const unauthorizedListeners = new Set<() => void>();

export async function loadSession(): Promise<{ token: string | null; server: string }> {
  try {
    const [t, s] = await Promise.all([SecureStore.getItemAsync(TOKEN_KEY), AsyncStorage.getItem(SERVER_KEY)]);
    token = t;
    if (s) server = s;
  } catch {
    token = null;
  }
  return { token, server };
}

export function getToken(): string | null {
  return token;
}
export function getServerUrl(): string {
  return server;
}

export async function setSession(next: { token: string | null; server?: string }): Promise<void> {
  token = next.token;
  if (next.server !== undefined) {
    server = normalizeServer(next.server);
    await AsyncStorage.setItem(SERVER_KEY, server);
  }
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

export function normalizeServer(input: string): string {
  let s = input.trim();
  if (!s) return DEFAULT_SERVER;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "").replace(/\/api$/, "");
}

export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}
/** Called by the API client on a 401: the token is dead, the app goes back to the lock screen. */
export function notifyUnauthorized(): void {
  for (const fn of unauthorizedListeners) fn();
}
