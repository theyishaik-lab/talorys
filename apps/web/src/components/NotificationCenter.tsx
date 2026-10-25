import { BellOff, Lightbulb, Trash2, X } from "lucide-react";
import { useState } from "react";
import { Button, Dialog, EmptyState, Spinner } from "./ui";
import { Markdown } from "./Markdown";
import { keys, useApiMutation, useNotifications, useSuggestions } from "../hooks/queries";
import { api } from "../lib/api";
import { cn, relativeTime } from "../lib/utils";
import { useT } from "../lib/i18n";
import { useNav } from "../lib/native";

type Tab = "notifications" | "suggestions";

/** In-app notification center for reminders, automation results, and proactive suggestions. */
export function NotificationCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("notifications");
  const { data: notifData, isLoading: notifLoading } = useNotifications();
  const { data: suggData, isLoading: suggLoading } = useSuggestions();

  const nav = useNav();
  const markRead = useApiMutation((id?: string) => api("/notifications/read", { method: "POST", body: id ? { id } : {} }), {
    invalidate: [keys.notifications],
  });
  const removeNotif = useApiMutation((id: string) => api(`/notifications/${id}`, { method: "DELETE" }), { invalidate: [keys.notifications] });
  const dismissSugg = useApiMutation((id: string) => api(`/suggestions/${id}`, { method: "PATCH", body: { status: "dismissed" } }), {
    invalidate: [keys.suggestions],
  });
  const markAllSeen = useApiMutation(() => api("/suggestions/seen", { method: "POST" }), { invalidate: [keys.suggestions] });

  const unseenCount = suggData?.unseen ?? 0;
  const unreadCount = notifData?.unread ?? 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("nav.notifications")}
      wide
      footer={
        tab === "notifications" && unreadCount > 0 ? (
          <Button variant="outline" size="sm" onClick={() => markRead.mutate(undefined)} loading={markRead.isPending}>
            {t("notifications.markAllRead")}
          </Button>
        ) : tab === "suggestions" && unseenCount > 0 ? (
          <Button variant="outline" size="sm" onClick={() => markAllSeen.mutate(undefined)} loading={markAllSeen.isPending}>
            {t("suggestions.markAllSeen")}
          </Button>
        ) : undefined
      }
    >
      {/* Tab strip */}
      <div className="mb-3 flex gap-1 rounded-xl bg-muted p-1" role="tablist">
        <TabBtn active={tab === "notifications"} onClick={() => setTab("notifications")} badge={unreadCount}>
          {t("nav.notifications")}
        </TabBtn>
        <TabBtn active={tab === "suggestions"} onClick={() => setTab("suggestions")} badge={unseenCount}>
          {t("suggestions.title")}
        </TabBtn>
      </div>

      {tab === "notifications" ? (
        notifLoading ? (
          <CenterSpinner />
        ) : !notifData?.notifications.length ? (
          <EmptyState icon={<BellOff className="h-8 w-8" />} title={t("notifications.empty")}>
            {t("notifications.emptyHint")}
          </EmptyState>
        ) : (
          <ul className="-mx-2 divide-y divide-border">
            {notifData.notifications.map((n) => (
              <li key={n.id} className={cn("group flex gap-3 rounded-lg px-2 py-3", !n.read_at && "bg-accent-soft/60")}>
                <span className={cn("mt-2 h-2 w-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-accent")} />
                <div className="min-w-0 flex-1" onClick={() => !n.read_at && markRead.mutate(n.id)}>
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="font-medium" dir="auto">{n.title}</p>
                    <time className="shrink-0 text-xs text-fg-subtle">{relativeTime(n.created_at)}</time>
                  </div>
                  <div className="mt-1 text-sm text-fg-muted" dir="auto">
                    <Markdown content={n.body} compact />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => removeNotif.mutate(n.id)}
                  className="self-start rounded p-1 text-fg-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus:opacity-100"
                  aria-label={t("notifications.delete")}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )
      ) : suggLoading ? (
        <CenterSpinner />
      ) : !suggData?.suggestions.length ? (
        <EmptyState icon={<Lightbulb className="h-8 w-8" />} title={t("suggestions.empty")}>
          {t("suggestions.emptyHint")}
        </EmptyState>
      ) : (
        <ul className="-mx-2 divide-y divide-border">
          {suggData.suggestions.map((s) => (
            <li key={s.id} className={cn("group flex gap-3 rounded-lg px-2 py-3", s.status === "new" && "bg-accent-soft/60")}>
              <span className={cn("mt-2 h-2 w-2 shrink-0 rounded-full", s.status === "new" ? "bg-accent" : "bg-transparent")} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-medium" dir="auto">{s.title}</p>
                  <time className="shrink-0 text-xs text-fg-subtle">{relativeTime(s.created_at)}</time>
                </div>
                <p className="mt-1 text-sm text-fg-muted" dir="auto">{s.body}</p>
                {s.proposed_tool && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    title={t("suggestions.approveHint")}
                    onClick={() => {
                      onClose();
                      nav(`/chat?prefill=${encodeURIComponent(`${s.title}\n${s.body}`)}`, "push");
                    }}
                  >
                    {t("nav.chat")}
                  </Button>
                )}
              </div>
              <button
                type="button"
                onClick={() => dismissSugg.mutate(s.id)}
                className="self-start rounded p-1 text-fg-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100 focus:opacity-100"
                aria-label={t("suggestions.dismiss")}
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

function TabBtn({ active, onClick, badge, children }: { active: boolean; onClick: () => void; badge?: number; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "pressable relative flex flex-1 items-center justify-center gap-1.5 rounded-[9px] py-1.5 text-[13.5px] font-medium transition-colors",
        active ? "bg-[var(--seg-on)] text-fg shadow-sm" : "text-fg-muted",
      )}
    >
      {children}
      {!!badge && (
        <span className="flex h-4 min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-white">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </button>
  );
}

function CenterSpinner() {
  return (
    <div className="flex justify-center py-10">
      <Spinner />
    </div>
  );
}
