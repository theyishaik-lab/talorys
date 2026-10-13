import { useEffect, useState } from "react";
import { NavLink, useNavigate } from "react-router";
import type { Conversation } from "@talorys/shared";
import { Brain, CalendarClock, CheckSquare, LogOut, MoreHorizontal, NotebookPen, Pencil, Search, Settings, SquarePen, Trash2, X } from "lucide-react";
import { Button, ConfirmDialog, Dialog, Input, Spinner } from "./ui";
import { keys, useApiMutation, useConversations, useSettings } from "../hooks/queries";
import { useSession } from "../hooks/session";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { type StringKey, useT } from "../lib/i18n";

/**
 * The one navigation surface: a static sidebar on wide screens, a slide-in drawer on phones
 * (from the start edge, so from the right in Hebrew). Search, new chat, the pages, the chat
 * history grouped by day, and the account row at the bottom.
 */

export const PAGES: readonly { to: string; label: StringKey; icon: typeof Brain }[] = [
  { to: "/memory", label: "nav.memory", icon: Brain },
  { to: "/tasks", label: "nav.tasks", icon: CheckSquare },
  { to: "/notes", label: "nav.notes", icon: NotebookPen },
  { to: "/automations", label: "nav.automations", icon: CalendarClock },
];

export function Drawer({ activeId, onNavigate, onClose }: { activeId?: string; onNavigate: () => void; onClose?: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const settings = useSettings();
  const { logout } = useSession();
  const agentName = settings.data?.agentName ?? "Talorys";
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(id);
  }, [q]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <span className="text-[15px] font-semibold tracking-[0.14em] uppercase">{agentName}</span>
        {onClose ? (
          <button type="button" onClick={onClose} className="pressable -me-2 rounded-xl p-2.5 text-fg-2 hover:bg-subtle" aria-label={t("common.close")}>
            <X className="h-5 w-5" />
          </button>
        ) : (
          <button type="button" onClick={() => void logout()} className="pressable -me-2 rounded-xl p-2.5 text-fg-muted hover:bg-subtle hover:text-fg" aria-label={t("nav.lock")} title={t("nav.lock")}>
            <LogOut className="h-[18px] w-[18px] rtl:-scale-x-100" />
          </button>
        )}
      </div>

      <div className="px-4">
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 h-[17px] w-[17px] -translate-y-1/2 text-fg-subtle" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("drawer.search")}
            className="h-10 rounded-xl border-0 bg-subtle ps-10 text-[14.5px] focus:bg-subtle focus:ring-0"
            aria-label={t("chat.searchConversations")}
            dir="auto"
          />
        </div>
        <button
          type="button"
          onClick={() => {
            navigate("/chat");
            onNavigate();
          }}
          className="pressable mt-3 flex h-11 w-full items-center gap-2.5 rounded-xl border border-border px-3 text-[14.5px] font-medium text-fg hover:bg-subtle"
        >
          <SquarePen className="h-[18px] w-[18px] text-fg-muted" />
          {t("chat.newConversation")}
        </button>
      </div>

      <nav className="px-2 pt-2" aria-label="Main">
        {PAGES.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                "pressable flex items-center gap-3 rounded-lg px-2.5 py-2 text-[14.5px] transition-colors",
                isActive ? "bg-muted font-medium text-fg" : "text-fg-2 hover:bg-subtle hover:text-fg",
              )
            }
          >
            <Icon className="h-[18px] w-[18px] text-fg-muted" />
            {t(label)}
          </NavLink>
        ))}
      </nav>

      <ConversationList activeId={activeId} query={debounced} onNavigate={onNavigate} />

      <div className="flex items-center gap-3 border-t border-border px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
        <div className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-full bg-accent-soft text-sm font-semibold text-accent-text" aria-hidden>
          {agentName.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14.5px] font-medium leading-tight">{agentName}</p>
          <p className="truncate text-xs text-fg-muted">{t("drawer.yourAgent")}</p>
        </div>
        <NavLink
          to="/settings"
          onClick={onNavigate}
          className={({ isActive }) => cn("pressable rounded-xl p-2.5 hover:bg-subtle", isActive ? "text-fg" : "text-fg-2")}
          aria-label={t("nav.settings")}
        >
          <Settings className="h-5 w-5" />
        </NavLink>
      </div>
    </div>
  );
}

type Bucket = "drawer.today" | "drawer.yesterday" | "drawer.thisWeek" | "drawer.earlier";

function bucketOf(iso: string, now: Date): Bucket {
  const d = new Date(iso);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86400_000;
  if (d.getTime() >= startOfToday) return "drawer.today";
  if (d.getTime() >= startOfToday - day) return "drawer.yesterday";
  if (d.getTime() >= startOfToday - 6 * day) return "drawer.thisWeek";
  return "drawer.earlier";
}

/** Chat history grouped by day, with rename/delete behind the row menu. */
export function ConversationList({ activeId, query, onNavigate }: { activeId?: string; query: string; onNavigate: () => void }) {
  const list = useConversations(query || undefined);
  const navigate = useNavigate();
  const t = useT();
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState<Conversation | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [title, setTitle] = useState("");

  const rename = useApiMutation(
    (v: { id: string; title: string }) => api(`/conversations/${v.id}`, { method: "PATCH", body: { title: v.title } }),
    { invalidate: [["conversations"], ["conversation"]], onSuccess: () => setRenaming(null) },
  );
  const remove = useApiMutation((id: string) => api(`/conversations/${id}`, { method: "DELETE" }), {
    invalidate: [["conversations"], keys.notifications],
    success: t("chat.deleted"),
    onSuccess: (_r, id) => {
      setDeleting(null);
      if (id === activeId) navigate("/chat");
    },
  });

  const groups: { bucket: Bucket; items: Conversation[] }[] = [];
  if (list.data) {
    const now = new Date();
    for (const c of list.data) {
      const bucket = bucketOf(c.updated_at, now);
      const last = groups.at(-1);
      if (last && last.bucket === bucket) last.items.push(c);
      else groups.push({ bucket, items: [c] });
    }
  }

  return (
    <nav className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1" aria-label={t("chat.conversations")}>
      {list.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : !list.data?.length ? (
        <p className="px-3 py-6 text-center text-sm text-fg-subtle">{query ? t("chat.noMatches") : t("chat.noConversations")}</p>
      ) : (
        groups.map((g) => (
          <section key={g.bucket}>
            <h3 className="px-2.5 pb-1 pt-3.5 text-xs font-semibold tracking-wide text-fg-subtle">{t(g.bucket)}</h3>
            <ul>
              {g.items.map((c) => (
                <li key={c.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => {
                      navigate(`/chat/${c.id}`);
                      onNavigate();
                    }}
                    className={cn(
                      "pressable flex w-full items-center rounded-lg px-2.5 py-2 pe-9 text-start text-[14.5px] transition-colors",
                      c.id === activeId ? "bg-muted font-medium text-fg" : "text-fg-2 hover:bg-subtle hover:text-fg",
                    )}
                  >
                    <span className="truncate" dir="auto">
                      {c.title}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setMenu(menu === c.id ? null : c.id)}
                    className={cn(
                      "absolute end-1 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-fg-subtle hover:bg-border hover:text-fg focus:opacity-100 group-hover:opacity-100",
                      c.id === activeId || menu === c.id ? "opacity-100" : "opacity-0",
                    )}
                    aria-label={t("chat.optionsFor", { title: c.title })}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {menu === c.id && (
                    <div className="absolute end-1 top-9 z-10 w-40 rounded-xl border border-border bg-surface py-1 shadow-card animate-fade-in" onMouseLeave={() => setMenu(null)}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-subtle"
                        onClick={() => {
                          setTitle(c.title);
                          setRenaming(c);
                          setMenu(null);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" /> {t("common.rename")}
                      </button>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger-soft"
                        onClick={() => {
                          setDeleting(c);
                          setMenu(null);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" /> {t("common.delete")}
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <Dialog
        open={!!renaming}
        onClose={() => setRenaming(null)}
        title={t("chat.renameTitle")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => renaming && title.trim() && rename.mutate({ id: renaming.id, title: title.trim() })} loading={rename.isPending}>
              {t("common.save")}
            </Button>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (renaming && title.trim()) rename.mutate({ id: renaming.id, title: title.trim() });
          }}
        >
          <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} autoFocus aria-label={t("chat.title")} dir="auto" />
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!deleting}
        title={t("chat.deleteTitle")}
        message={t("chat.deleteMessage", { title: deleting?.title ?? "" })}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </nav>
  );
}
