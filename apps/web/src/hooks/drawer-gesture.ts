import { type RefObject, useEffect } from "react";
import { flushSync } from "react-dom";

/**
 * The drawer follows the finger: a swipe in from the start edge opens it, a swipe back (on the
 * panel or the scrim) closes it, and the release decides by velocity, then by position. While the
 * finger is down the panel's transform and the scrim's opacity are set directly (no React, no
 * layout); on release the CSS transition carries the panel the rest of the way.
 *
 * Only the transform animates, so the drawer never triggers layout or paint of the screen behind it.
 */
export function useDrawerGesture(opts: {
  panel: RefObject<HTMLElement | null>;
  scrim: RefObject<HTMLElement | null>;
  open: boolean;
  setOpen: (v: boolean) => void;
  rtl: boolean;
  enabled: boolean;
}): void {
  const { panel, scrim, open, setOpen, rtl, enabled } = opts;
  useEffect(() => {
    if (!enabled) return;
    const EDGE = 28; // px from the start edge where an "open" swipe may begin
    const SLOP = 10; // px before a gesture is classified
    const FLICK = 0.35; // px/ms
    let x0 = 0;
    let y0 = 0;
    let decided: "h" | "v" | null = null;
    let active = false;
    let opening = false;
    let width = 300;
    let samples: { x: number; t: number }[] = [];
    let lastProgress = open ? 1 : 0;
    // Opening moves the finger toward the end edge: leftwards in RTL (dx < 0), rightwards in LTR.
    const towardOpen = (dx: number) => (rtl ? -dx : dx);

    const draw = (p: number) => {
      lastProgress = p;
      const el = panel.current;
      const sc = scrim.current;
      if (!el) return;
      const sign = rtl ? 1 : -1;
      el.style.transition = "none";
      el.style.transform = `translate3d(${((1 - p) * sign * width).toFixed(1)}px, 0, 0)`;
      el.style.visibility = "visible";
      if (sc) {
        sc.style.transition = "none";
        sc.style.opacity = p.toFixed(3);
        sc.style.visibility = "visible";
        sc.style.pointerEvents = p > 0 ? "auto" : "none";
      }
    };
    const settle = (target: boolean) => {
      const el = panel.current;
      const sc = scrim.current;
      // Hand over to the CSS transition from wherever the finger left the panel.
      flushSync(() => setOpen(target));
      if (el) {
        el.style.transition = "";
        el.style.transform = "";
        el.style.visibility = "";
      }
      if (sc) {
        sc.style.transition = "";
        sc.style.opacity = "";
        sc.style.visibility = "";
        sc.style.pointerEvents = "";
      }
    };

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t) return;
      const fromEdge = rtl ? window.innerWidth - t.clientX : t.clientX;
      if (!open && fromEdge > EDGE) return;
      if (open) {
        // Any touch while open may become a close swipe (on the panel or the scrim); taps still work.
        const inPanel = panel.current?.contains(e.target as Node);
        if (!inPanel && !scrim.current?.contains(e.target as Node)) return;
      }
      x0 = t.clientX;
      y0 = t.clientY;
      decided = null;
      active = true;
      opening = !open;
      width = panel.current?.offsetWidth || 300;
      samples = [{ x: t.clientX, t: e.timeStamp }];
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!active || !t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (!decided) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          decided = "v";
          active = false; // a vertical scroll, not ours
          return;
        }
        // An open panel scrolls its own list; a horizontal move inside it that heads toward "open" is nothing.
        if (!opening && towardOpen(dx) > 0) {
          decided = "v";
          active = false;
          return;
        }
        decided = "h";
      }
      if (decided !== "h") return;
      if (e.cancelable) e.preventDefault();
      samples.push({ x: t.clientX, t: e.timeStamp });
      if (samples.length > 6) samples.shift();
      const p = opening ? towardOpen(dx) / width : 1 + towardOpen(dx) / width;
      draw(Math.min(1, Math.max(0, p)));
    };
    const onEnd = (e: TouchEvent) => {
      if (!active) return;
      active = false;
      if (decided !== "h") return;
      const last = samples[samples.length - 1] ?? { x: x0, t: e.timeStamp };
      const first = samples.find((s) => last.t - s.t <= 100) ?? last;
      const dt = Math.max(1, last.t - first.t);
      const v = towardOpen(last.x - first.x) / dt; // + = toward open
      let target: boolean;
      if (v > FLICK) target = true;
      else if (v < -FLICK) target = false;
      else target = lastProgress > 0.5;
      if (e.cancelable && e.type === "touchend") e.preventDefault();
      settle(target);
    };
    const opt: AddEventListenerOptions = { passive: false };
    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, opt);
    document.addEventListener("touchend", onEnd, opt);
    document.addEventListener("touchcancel", onEnd, opt);
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onEnd);
    };
  }, [panel, scrim, open, setOpen, rtl, enabled]);
}
