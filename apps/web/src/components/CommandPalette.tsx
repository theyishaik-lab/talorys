import { useEffect, useRef, useState } from "react";
import { Command } from "cmdk";
import { Brain, CalendarClock, CheckSquare, MessageSquare, NotebookPen, Plug, Search, Settings } from "lucide-react";
import { useNavigate } from "react-router";
import { useConversations, useMemories, useNotes, useTasks } from "../hooks/queries";
import { useHistoryLayer } from "../lib/native";
import { useT } from "../lib/i18n";

const NAV_ITEMS = [
  { to: "/chat", label: "nav.chat", icon: MessageSquare },
  { to: "/tasks", label: "nav.tasks", icon: CheckSquare },
  { to: "/notes", label: "nav.notes", icon: NotebookPen },
  { to: "/memory", label: "nav.memory", icon: Brain },
  { to: "/automations", label: "nav.automations", icon: CalendarClock },
  { to: "/connections", label: "nav.connections", icon: Plug },
  { to: "/settings", label: "nav.settings", icon: Settings },
] as const;

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useHistoryLayer(open, onClose);

  // Fetch data lazily only when open.
  const tasks = useTasks();
  const notes = useNotes(q || undefined);
  const memories = useMemories(q || undefined);
  const conversations = useConversations(q || undefined);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      setQ("");
    }
    if (!open && el.open) el.close();
  }, [open]);

  const go = (path: string) => {
    onClose();
    void navigate(path);
  };

  const filteredTasks = q
    ? (tasks.data ?? []).filter((t) => t.title.toLowerCase().includes(q.toLowerCase())).slice(0, 5)
    : [];
  const filteredNotes = (notes.data ?? []).slice(0, 5);
  const filteredMemories = (memories.data?.memories ?? []).slice(0, 5);
  const filteredChats = (conversations.data ?? []).slice(0, 5);

  const hasResults = q
    ? filteredTasks.length + filteredNotes.length + filteredMemories.length + filteredChats.length > 0
    : true;

  return (
    <dialog
      ref={dialogRef}
      onClose={() => { if (open) onClose(); }}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === dialogRef.current) onClose(); }}
      className="fixed inset-x-0 top-[10vh] m-auto w-[calc(100%-2rem)] max-w-xl rounded-2xl border border-border bg-surface p-0 text-fg shadow-[0_8px_40px_rgba(0,0,0,0.25)] backdrop:bg-[var(--scrim)] animate-slide-up"
    >
      {open && (
        <Command className="overflow-hidden rounded-2xl" loop shouldFilter={false}>
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            <Search className="h-4 w-4 shrink-0 text-fg-muted" />
            <Command.Input
              value={q}
              onValueChange={setQ}
              placeholder={t("command.placeholder")}
              className="flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-subtle"
              autoFocus
            />
            {q && (
              <button
                type="button"
                onClick={() => setQ("")}
                className="text-[12px] text-fg-subtle hover:text-fg"
              >
                ✕
              </button>
            )}
            <kbd className="hidden rounded border border-border px-1.5 py-0.5 text-[11px] text-fg-subtle sm:block">
              Esc
            </kbd>
          </div>

          <Command.List className="max-h-[min(480px,70dvh)] overflow-y-auto p-2 scrollbar-thin">
            {!hasResults && (
              <Command.Empty className="py-8 text-center text-sm text-fg-muted">
                {t("command.empty", { q })}
              </Command.Empty>
            )}

            {/* Navigation group — shown always when no query, or when filtered label matches */}
            {(!q || NAV_ITEMS.some((n) => t(n.label).toLowerCase().includes(q.toLowerCase()))) && (
              <Command.Group
                heading={t("command.navigation")}
                className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:text-[11px] [&>[cmdk-group-heading]]:font-semibold [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-wide [&>[cmdk-group-heading]]:text-fg-subtle"
              >
                {NAV_ITEMS.filter((n) => !q || t(n.label).toLowerCase().includes(q.toLowerCase())).map(
                  ({ to, label, icon: Icon }) => (
                    <Command.Item
                      key={to}
                      value={`nav:${to}:${t(label)}`}
                      onSelect={() => go(to)}
                      className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[14px] text-fg-2 aria-selected:bg-muted aria-selected:text-fg"
                    >
                      <Icon className="h-4 w-4 text-fg-muted" />
                      {t(label)}
                    </Command.Item>
                  ),
                )}
              </Command.Group>
            )}

            {filteredTasks.length > 0 && (
              <Command.Group
                heading={t("command.tasks")}
                className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:text-[11px] [&>[cmdk-group-heading]]:font-semibold [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-wide [&>[cmdk-group-heading]]:text-fg-subtle"
              >
                {filteredTasks.map((task) => (
                  <Command.Item
                    key={task.id}
                    value={`task:${task.id}:${task.title}`}
                    onSelect={() => go("/tasks")}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[14px] text-fg-2 aria-selected:bg-muted aria-selected:text-fg"
                  >
                    <CheckSquare className="h-4 w-4 shrink-0 text-fg-muted" />
                    <span className="truncate">{task.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {filteredNotes.length > 0 && (
              <Command.Group
                heading={t("command.notes")}
                className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:text-[11px] [&>[cmdk-group-heading]]:font-semibold [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-wide [&>[cmdk-group-heading]]:text-fg-subtle"
              >
                {filteredNotes.map((note) => (
                  <Command.Item
                    key={note.id}
                    value={`note:${note.id}:${note.title}`}
                    onSelect={() => go(`/notes/${note.id}`)}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[14px] text-fg-2 aria-selected:bg-muted aria-selected:text-fg"
                  >
                    <NotebookPen className="h-4 w-4 shrink-0 text-fg-muted" />
                    <span className="truncate">{note.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {filteredMemories.length > 0 && (
              <Command.Group
                heading={t("command.memories")}
                className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:text-[11px] [&>[cmdk-group-heading]]:font-semibold [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-wide [&>[cmdk-group-heading]]:text-fg-subtle"
              >
                {filteredMemories.map((mem) => (
                  <Command.Item
                    key={mem.id}
                    value={`mem:${mem.id}:${mem.content}`}
                    onSelect={() => go("/memory")}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[14px] text-fg-2 aria-selected:bg-muted aria-selected:text-fg"
                  >
                    <Brain className="h-4 w-4 shrink-0 text-fg-muted" />
                    <span className="truncate">{mem.content}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {filteredChats.length > 0 && (
              <Command.Group
                heading={t("command.chats")}
                className="[&>[cmdk-group-heading]]:px-2 [&>[cmdk-group-heading]]:py-1.5 [&>[cmdk-group-heading]]:text-[11px] [&>[cmdk-group-heading]]:font-semibold [&>[cmdk-group-heading]]:uppercase [&>[cmdk-group-heading]]:tracking-wide [&>[cmdk-group-heading]]:text-fg-subtle"
              >
                {filteredChats.map((conv) => (
                  <Command.Item
                    key={conv.id}
                    value={`conv:${conv.id}:${conv.title}`}
                    onSelect={() => go(`/chat/${conv.id}`)}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[14px] text-fg-2 aria-selected:bg-muted aria-selected:text-fg"
                  >
                    <MessageSquare className="h-4 w-4 shrink-0 text-fg-muted" />
                    <span className="truncate">{conv.title}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>

          <div className="border-t border-border px-4 py-2 text-[11px] text-fg-subtle">
            {t("command.hint")} · <kbd className="rounded border border-border px-1 py-0.5">↑↓</kbd> navigate · <kbd className="rounded border border-border px-1 py-0.5">↵</kbd> open
          </div>
        </Command>
      )}
    </dialog>
  );
}
