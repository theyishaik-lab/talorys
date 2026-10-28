import type { ChatMessage, Notification } from "@talorys/shared";

/**
 * Fixed chat threads, matching the agent (apps/agent/src/agent/threads.ts):
 * - `main` is the one continuous chat (the Chat tab). Its prompt carries a digest of recent
 *   notifications, tasks and projects.
 * - `project-<id>` is a project's own chat.
 * - `updates-*` threads hold the full text of each notification (what a push tap opens).
 *
 * Notifications are shown INLINE in the main chat (merged by time, client-side) and are not copied
 * into its history: what the owner sees there is exactly what the agent's digest describes.
 */
export const MAIN_THREAD_ID = "main";
export const projectThreadId = (projectId: string) => `project-${projectId}`;
export const isUpdatesThread = (id: string) => id.startsWith("updates-");

/** The `updates-*` thread a notification was written to (same rule as the agent). */
export function notificationThreadId(automationId: string | null): string {
  return automationId ? `updates-${automationId.replace(/[^A-Za-z0-9_-]/g, "")}` : "updates-inbox";
}

export interface NoticeRow {
  id: string;
  role: "notice";
  created_at: string;
  notification: Notification;
}

/** How far back notifications are shown inline in the main chat. */
export const INLINE_NOTICE_DAYS = 7;

/**
 * Messages and notifications in one time-ordered list. Notifications older than the window, or
 * older than the first message when the chat has history further back, are left out so the
 * inline view stays a recent feed rather than a second bell.
 */
export function mergeNotices(messages: ChatMessage[], notifications: Notification[], now: number, days = INLINE_NOTICE_DAYS): (ChatMessage | NoticeRow)[] {
  const since = now - days * 86_400_000;
  const notices: NoticeRow[] = notifications
    .filter((n) => Date.parse(n.created_at) >= since)
    .map((n) => ({ id: `notice-${n.id}`, role: "notice", created_at: n.created_at, notification: n }));
  if (notices.length === 0) return messages;
  const out: (ChatMessage | NoticeRow)[] = [...messages, ...notices];
  // Stable: equal timestamps keep messages before notices.
  return out
    .map((row, i) => ({ row, i, t: Date.parse(row.created_at) || 0 }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.row);
}
