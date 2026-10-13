import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Outlet, useLocation, useMatch } from "react-router";
import { useDrawerGesture } from "../hooks/drawer-gesture";
import { type NavDirection, useHistoryLayer, useMediaQuery, useNav } from "../lib/native";
import { Bell, Menu } from "lucide-react";
import { Drawer, PAGES } from "./Drawer";
import { NotificationCenter } from "./NotificationCenter";
import { useNotifications } from "../hooks/queries";
import { cn } from "../lib/utils";
import { type StringKey, useLocale, useT } from "../lib/i18n";

interface ShellContextValue {
  openDrawer: () => void;
  openNotifications: () => void;
  unread: number;
}

/** The phone breakpoint where the drawer becomes a fixed sidebar (Tailwind `lg`). */
const WIDE = "(min-width: 1024px)";
const ShellContext = createContext<ShellContextValue | null>(null);

export function useShell(): ShellContextValue {
  const v = useContext(ShellContext);
  if (!v) throw new Error("useShell outside AppShell");
  return v;
}

/** The round icon button used in every top bar. */
export function IconButton({ onClick, label, children, className }: { onClick?: () => void; label: string; children: ReactNode; className?: string }) {
  return (
    <button type="button" onClick={onClick} className={cn("pressable relative grid h-10 w-10 shrink-0 place-items-center rounded-xl text-fg-2 hover:bg-subtle", className)} aria-label={label}>
      {children}
    </button>
  );
}

export function MenuButton() {
  const { openDrawer } = useShell();
  const t = useT();
  return (
    <IconButton onClick={openDrawer} label={t("drawer.menu")} className="lg:hidden">
      <Menu className="h-5 w-5" />
    </IconButton>
  );
}

export function BellButton() {
  const { openNotifications, unread } = useShell();
  const t = useT();
  return (
    <IconButton onClick={openNotifications} label={unread ? t("nav.notificationsUnread", { n: unread }) : t("nav.notifications")}>
      <Bell className="h-5 w-5" />
      {unread > 0 && <span className="absolute end-2.5 top-2 h-[7px] w-[7px] rounded-full bg-accent ring-2 ring-bg" />}
    </IconButton>
  );
}

/** One top bar shape for every screen: start action, centered title, end actions. */
export function TopBar({ start, title, end, className }: { start?: ReactNode; title?: ReactNode; end?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex h-[52px] shrink-0 items-center gap-1 px-2 pt-[env(safe-area-inset-top)] box-content", className)}>
      <div className="flex min-w-[40px] items-center">{start}</div>
      <div className="min-w-0 flex-1 text-center">{title}</div>
      <div className="flex min-w-[40px] items-center justify-end">{end}</div>
    </header>
  );
}

export function AppShell() {
  const t = useT();
  const { dir } = useLocale();
  const nav = useNav();
  const notifications = useNotifications();
  const [notifOpen, setNotifOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const wide = useMediaQuery(WIDE);
  const conversationId = useMatch("/chat/:conversationId")?.params.conversationId;
  const unread = notifications.data?.unread ?? 0;
  const isChat = location.pathname.startsWith("/chat");
  // Chat and Settings draw their own top bar (title + subtitle, back navigation).
  const ownBar = isChat || location.pathname.startsWith("/settings");
  const pageLabel: StringKey | undefined = PAGES.find((p) => location.pathname.startsWith(p.to))?.label;

  const panelRef = useRef<HTMLElement>(null);
  const scrimRef = useRef<HTMLButtonElement>(null);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  // Android back closes the drawer instead of leaving the app.
  useHistoryLayer(drawerOpen && !wide, closeDrawer);
  // Escape too.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);
  useDrawerGesture({ panel: panelRef, scrim: scrimRef, open: drawerOpen, setOpen: setDrawerOpen, rtl: dir === "rtl", enabled: !wide });

  // A tap in the drawer: close it and move on. The drawer's own history entry is replaced by the
  // destination, so Back from there returns to the screen the drawer was opened over. Stable
  // identity (refs) so the memoised drawer does not re-render on every open/close.
  const stateRef = useRef({ drawerOpen, wide });
  stateRef.current = { drawerOpen, wide };
  const goFromDrawer = useCallback(
    (to: string, direction: NavDirection = "fade") => {
      const replace = stateRef.current.drawerOpen && !stateRef.current.wide;
      setDrawerOpen(false);
      nav(to, direction, { replace });
    },
    [nav],
  );

  const ctx = useMemo<ShellContextValue>(() => ({ openDrawer: () => setDrawerOpen(true), openNotifications: () => setNotifOpen(true), unread }), [unread]);

  return (
    <ShellContext.Provider value={ctx}>
      <div className="app-viewport flex overflow-hidden">
        {wide ? (
          /* Wide screens: the drawer is a fixed sidebar. */
          <aside className="flex w-[300px] shrink-0 flex-col border-e border-border bg-bg">
            <Drawer activeId={conversationId} go={goFromDrawer} />
          </aside>
        ) : (
          /* Phones: one drawer, mounted once, slid in and out with a transform (no mount, no layout per open). */
          <div className="drawer-root fixed inset-0 z-40" aria-hidden={!drawerOpen}>
            <button ref={scrimRef} type="button" className="drawer-scrim absolute inset-0 bg-[var(--scrim)]" data-open={drawerOpen ? "" : undefined} aria-label={t("common.close")} onClick={closeDrawer} tabIndex={-1} />
            <aside
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label={t("drawer.menu")}
              data-open={drawerOpen ? "" : undefined}
              className="drawer-panel absolute inset-y-0 start-0 flex w-[min(318px,86vw)] flex-col rounded-e-3xl bg-bg shadow-card"
            >
              <Drawer activeId={conversationId} go={goFromDrawer} onClose={closeDrawer} />
            </aside>
          </div>
        )}

        <div className="screen flex min-w-0 flex-1 flex-col">
          {!ownBar && (
            <TopBar
              start={<MenuButton />}
              title={<h1 className="truncate text-[16px] font-semibold">{pageLabel ? t(pageLabel) : ""}</h1>}
              end={<BellButton />}
            />
          )}
          <main className={cn("min-h-0 flex-1", ownBar ? "overflow-hidden" : "scrollbar-thin overflow-y-auto pb-[env(safe-area-inset-bottom)]")}>
            <Outlet />
          </main>
        </div>

        <NotificationCenter open={notifOpen} onClose={() => setNotifOpen(false)} />
      </div>
    </ShellContext.Provider>
  );
}
