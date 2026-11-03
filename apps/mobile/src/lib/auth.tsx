import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "./api";
import { getServerUrl, loadSession, onUnauthorized, setSession } from "./session";
import { registerForPush, unregisterPush } from "./push";
import { connectKeyboardSession } from "./keyboardBridge";

// Before the session loads (AuthProvider's effect), so the keyboard gets the stored session at start-up.
connectKeyboardSession();

export interface Session {
  authenticated: boolean;
  agent_name?: string;
}

export interface AuthState {
  ready: boolean;
  authenticated: boolean;
  agentName: string;
  server: string;
  signIn: (server: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AUTH_TIMEOUT_MS = 6000;

const AuthContext = createContext<AuthState>({ ready: false, authenticated: false, agentName: "Talorys", server: "", signIn: async () => {}, signOut: async () => {}, refresh: async () => {} });
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [agentName, setAgentName] = useState("Talorys");
  const [server, setServer] = useState("");

  const refresh = useCallback(async () => {
    try {
      const s = await api<Session>("/auth/session");
      setAuthenticated(s.authenticated);
      if (s.agent_name) setAgentName(s.agent_name);
    } catch (error) {
      // Offline: keep the stored session so the shell still opens; a 401 will sign out later.
      if (error instanceof ApiError && error.status === 401) setAuthenticated(false);
    }
  }, []);

  useEffect(() => {
    // Never wait forever on the keystore or the network: the shell opens after AUTH_TIMEOUT_MS at the latest.
    const timer = setTimeout(() => setReady(true), AUTH_TIMEOUT_MS);
    loadSession()
      .then(async ({ token, server: s }) => {
        setServer(s);
        if (token) {
          setAuthenticated(true);
          await refresh();
        }
      })
      .catch((e) => console.warn("loadSession failed", e))
      .finally(() => {
        clearTimeout(timer);
        setReady(true);
      });
    const off = onUnauthorized(() => {
      setAuthenticated(false);
      setSession({ token: null }).catch(() => {});
    });
    return () => {
      clearTimeout(timer);
      off();
    };
  }, [refresh]);

  const signIn = useCallback(async (serverUrl: string, password: string) => {
    await setSession({ token: null, server: serverUrl });
    setServer(getServerUrl());
    const res = await api<{ authenticated: boolean; token: string }>("/auth/login", { method: "POST", body: { password } });
    await setSession({ token: res.token });
    setAuthenticated(true);
    refresh().catch(() => {});
    // One Android permission prompt right after sign-in; the Settings toggle covers a later change of mind.
    registerForPush({ ask: true }).catch(() => {});
  }, [refresh]);

  const signOut = useCallback(async () => {
    await unregisterPush().catch(() => {});
    await api("/auth/logout", { method: "POST", body: {} }).catch(() => {});
    await setSession({ token: null });
    setAuthenticated(false);
  }, []);

  const value = useMemo(() => ({ ready, authenticated, agentName, server, signIn, signOut, refresh }), [ready, authenticated, agentName, server, signIn, signOut, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
