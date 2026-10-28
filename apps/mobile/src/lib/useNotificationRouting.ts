import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { router, useRootNavigationState } from "expo-router";
import { useEffect, useState } from "react";
import { NotificationGate, canRoute, hrefOf, notificationTarget } from "./notificationRouting";

/**
 * Opens the chat a tapped notification is about — once, and only when it is safe (see
 * notificationRouting.ts for the 0.2.3 loop this prevents). Module scope on purpose: the gate
 * outlives any remount of the root layout, so a tap is never handled twice in one process, and the
 * handled ids are persisted so an activity Android restores with the old launch intent doesn't
 * reopen it either.
 */
const HANDLED_KEY = "talorys.push.handled";
const gate = new NotificationGate();
let loaded: Promise<void> | null = null;
const loadHandled = (): Promise<void> =>
  (loaded ??= AsyncStorage.getItem(HANDLED_KEY)
    .then((raw) => {
      const ids = raw ? (JSON.parse(raw) as unknown) : [];
      if (Array.isArray(ids)) gate.preload(ids.filter((x): x is string => typeof x === "string"));
    })
    .catch(() => {}));

const idOf = (r: Notifications.NotificationResponse) => r.notification.request.identifier;

export function useNotificationRouting(auth: { ready: boolean; authenticated: boolean }): void {
  const rootState = useRootNavigationState();
  const [pending, setPending] = useState<Notifications.NotificationResponse | null>(null);
  const [storeReady, setStoreReady] = useState(false);

  // Collect taps; never navigate from here (this runs at mount, before the session is known).
  useEffect(() => {
    let alive = true;
    const offer = (r: Notifications.NotificationResponse | null) => {
      if (!r || r.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER || gate.has(idOf(r))) return;
      setPending(r);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(offer);
    loadHandled().then(() => {
      if (!alive) return;
      setStoreReady(true);
      try {
        offer(Notifications.getLastNotificationResponse());
      } catch {
        /* no native module (tests, web) */
      }
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);

  const ready = storeReady && canRoute(auth, rootState);
  useEffect(() => {
    if (!ready || !pending) return;
    const response = pending;
    // The gate, not this state, decides: an already-handled tap stays pending and is skipped here.
    if (!gate.admit(idOf(response), Date.now())) return;
    try {
      Notifications.clearLastNotificationResponse();
    } catch {
      /* ignore */
    }
    AsyncStorage.setItem(HANDLED_KEY, JSON.stringify(gate.ids())).catch(() => {});
    const target = notificationTarget(response.notification.request.content.data as Record<string, unknown>);
    if (!target) return;
    // navigate, not push: an already-open thread is reused instead of stacking another copy.
    router.navigate(hrefOf(target) as Parameters<typeof router.navigate>[0]);
  }, [ready, pending]);
}
