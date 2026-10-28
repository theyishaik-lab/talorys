import type { Automation, Notification, Suggestion, Task } from "@talorys/shared";
import { api } from "./api";
import { createStore } from "./store";

/** Unread notifications, shown as the Home tab's badge. */
export const unreadStore = createStore(0);

export async function loadNotifications(): Promise<{ notifications: Notification[]; unread: number }> {
  const r = await api<{ notifications: Notification[]; unread: number }>("/notifications");
  unreadStore.set(r.unread);
  return r;
}

export async function markRead(id?: string): Promise<void> {
  const r = await api<{ unread: number }>("/notifications/read", { method: "POST", body: id ? { id } : {} });
  unreadStore.set(r.unread);
}

export async function loadSuggestions(): Promise<Suggestion[]> {
  const r = await api<{ suggestions: Suggestion[] }>("/suggestions?status=new&limit=10");
  return r.suggestions;
}

export async function setSuggestionStatus(id: string, status: "accepted" | "dismissed"): Promise<void> {
  await api(`/suggestions/${id}`, { method: "PATCH", body: { status } });
}

/** One row of "Today & upcoming": a task due today / overdue, or a reminder automation's next run. */
export type UpcomingItem =
  | { kind: "task"; id: string; title: string; at: string | null; overdue: boolean; task: Task }
  | { kind: "reminder"; id: string; title: string; at: string; automation: Automation };

/** How far ahead reminder automations are listed. */
export const REMINDER_HORIZON_MS = 48 * 3_600_000;

export function buildUpcoming(tasks: Task[], automations: Automation[], now: number): UpcomingItem[] {
  const items: UpcomingItem[] = tasks
    .filter((t) => t.status !== "done")
    .map((t) => ({ kind: "task" as const, id: `t-${t.id}`, title: t.title, at: t.due_at, overdue: !!t.due_at && Date.parse(t.due_at) < now, task: t }));
  for (const a of automations) {
    if (!a.enabled || a.kind !== "reminder" || !a.next_run) continue;
    const at = Date.parse(a.next_run);
    if (at < now - 60_000 || at > now + REMINDER_HORIZON_MS) continue;
    items.push({ kind: "reminder", id: `a-${a.id}`, title: a.message || a.name, at: a.next_run, automation: a });
  }
  const key = (i: UpcomingItem) => (i.at ? Date.parse(i.at) : Number.MAX_SAFE_INTEGER);
  return items.sort((a, b) => key(a) - key(b));
}

export async function loadUpcoming(now: number): Promise<UpcomingItem[]> {
  const [tasks, autos] = await Promise.all([
    api<{ tasks: Task[] }>("/tasks?view=today&limit=50").then((r) => r.tasks),
    api<{ automations: Automation[] }>("/automations").then((r) => r.automations).catch(() => [] as Automation[]),
  ]);
  return buildUpcoming(tasks, autos, now);
}
