/**
 * The native-app feel of the installed PWA, in one place: screen transitions (View Transitions API
 * with a plain fallback), the Android back button closing drawers/sheets/sub-screens instead of
 * leaving the app (history layers), haptic ticks, and a media-query hook.
 */
import { useCallback, useContext, useEffect, useRef, useSyncExternalStore } from "react";
import { type NavigateOptions, type To, UNSAFE_DataRouterContext, useNavigate } from "react-router";

export type NavDirection = "push" | "pop" | "fade" | "none";

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Whether this browser animates route changes (Chrome 111+, Safari 18+). */
export function viewTransitionsSupported(): boolean {
  return typeof document !== "undefined" && typeof (document as { startViewTransition?: unknown }).startViewTransition === "function" && !reduceMotion();
}

/** Marks the direction of the next screen change; the stylesheet picks the slide from it. */
export function setNavDirection(dir: NavDirection): void {
  document.documentElement.dataset.nav = dir;
}

/**
 * `navigate` with a native screen transition: `push` slides the new screen in from the end edge
 * (so from the left in Hebrew), `pop` slides it back out, `fade` cross-fades (drawer jumps).
 */
export function useNav() {
  const navigate = useNavigate();
  // The app's screens live in a descendant <Routes>, whose `useNavigate` ignores `viewTransition`;
  // the data router itself honours it (and replays it on Back).
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  return useCallback(
    (to: To | number, dir: NavDirection = "push", opts: NavigateOptions = {}) => {
      setNavDirection(dir);
      const vt = viewTransitionsSupported();
      if (typeof to === "number") {
        if (router) void router.navigate(to);
        else navigate(to);
      } else if (router) void router.navigate(to, { ...opts, viewTransition: vt });
      else navigate(to, { ...opts, viewTransition: vt });
    },
    [navigate, router],
  );
}

/** Browser back/forward is a `pop` unless something else says otherwise before the router renders. */
export function initNativeNavigation(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("popstate", () => {
    if (!document.documentElement.dataset.navLock) setNavDirection("pop");
  });
}

/**
 * A history entry for an overlay (drawer, sheet, dialog): opening it pushes one, the Android back
 * button pops it and the overlay closes; closing it from the UI pops the entry itself. The router's
 * own state (`idx`, `key`) is carried along so it keeps counting entries correctly.
 */
let layerSeq = 0;
export function useHistoryLayer(open: boolean, onClose: () => void): void {
  const id = useRef<string>("");
  if (!id.current) id.current = `layer-${++layerSeq}`;
  const pushed = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onPop = () => {
      if (!pushed.current) return;
      const state = window.history.state as { tl?: string } | null;
      if (state?.tl === id.current) return;
      pushed.current = false;
      // The router sees this pop as a navigation to the same screen; no slide for that.
      setNavDirection("none");
      close.current();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (open && !pushed.current) {
      const prev = (window.history.state ?? {}) as { idx?: number };
      window.history.pushState({ ...prev, idx: (prev.idx ?? 0) + 1, tl: id.current }, "");
      pushed.current = true;
    } else if (!open && pushed.current) {
      pushed.current = false;
      const state = window.history.state as { tl?: string } | null;
      // Only pop our own entry (a navigation may already have replaced it).
      if (state?.tl === id.current) {
        // The router treats the pop as a navigation to the same screen; it must not slide.
        setNavDirection("none");
        document.documentElement.dataset.navLock = "1";
        window.history.back();
        setTimeout(() => delete document.documentElement.dataset.navLock, 80);
      }
    }
  }, [open]);

  // An overlay unmounting while its entry is on the stack (e.g. a navigation replaced the URL) leaves nothing behind.
  useEffect(
    () => () => {
      if (pushed.current && (window.history.state as { tl?: string } | null)?.tl === id.current) {
        pushed.current = false;
        setNavDirection("none");
        window.history.back();
      }
    },
    [],
  );
}

/** Whether an overlay's own history entry is the current one (so a navigation should replace it). */
export function layerIsCurrent(): boolean {
  return typeof window !== "undefined" && !!(window.history.state as { tl?: string } | null)?.tl;
}

/** A short haptic tick where a native app would give one (approve, send, a drawer snapping). */
export function haptic(kind: "tap" | "success" | "warning" = "tap"): void {
  try {
    if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
    navigator.vibrate(kind === "success" ? [12, 40, 18] : kind === "warning" ? [25, 50, 25] : 10);
  } catch {
    /* not available */
  }
}

/** Reactive media query (no re-render until it flips). */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}
