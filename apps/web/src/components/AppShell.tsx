import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Outlet, useLocation, useMatch } from "react-router";
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
  const notifications = useNotifications();
  const [notifOpen, setNotifOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const conversationId = useMatch("/chat/:conversationId")?.params.conversationId;
  const unread = notifications.data?.unread ?? 0;
  const isChat = location.pathname.startsWith("/chat");
  // Chat and Settings draw their own top bar (title + subtitle, back navigation).
  const ownBar = isChat || location.pathname.startsWith("/settings");
  const pageLabel: StringKey | undefined = PAGES.find((p) => location.pathname.startsWith(p.to))?.label;

  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  // Any navigation closes the drawer; Escape too.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const ctx = useMemo<ShellContextValue>(() => ({ openDrawer: () => setDrawerOpen(true), openNotifications: () => setNotifOpen(true), unread }), [unread]);

  return (
    <ShellContext.Provider value={ctx}>
      <div className="app-viewport flex overflow-hidden">
        {/* Wide screens: the drawer is a fixed sidebar. */}
        <aside className="hidden w-[300px] shrink-0 border-e border-border bg-bg lg:flex lg:flex-col">
          <Drawer activeId={conversationId} onNavigate={() => {}} />
        </aside>

        {/* Phones: the same drawer slides in from the start edge (the right in Hebrew). */}
        {drawerOpen && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button type="button" className="absolute inset-0 bg-[var(--scrim)] animate-fade-in" aria-label={t("common.close")} onClick={closeDrawer} />
            <aside
              role="dialog"
              aria-modal="true"
              aria-label={t("drawer.menu")}
              className="absolute inset-y-0 start-0 flex w-[min(318px,86vw)] flex-col rounded-e-3xl bg-bg shadow-card animate-drawer-in"
              style={{ ["--drawer-from" as string]: dir === "rtl" ? "100%" : "-100%" }}
            >
              <Drawer activeId={conversationId} onNavigate={closeDrawer} onClose={closeDrawer} />
            </aside>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col">
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
