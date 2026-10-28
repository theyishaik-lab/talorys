import type { Services } from "../services/container";
import { formatLocal, localDayBounds } from "../services/time";

/**
 * Fixed-id chat threads (the native app's single main chat and one chat per project).
 *
 * - `main`: the one continuous conversation. Its system prompt carries a live digest of what the
 *   agent has been doing elsewhere (recent notifications and automation results, tasks due, project
 *   status, open suggestions), so the owner never has to say "about that reminder you sent".
 *   Notifications are NOT written into main's history: each still lands in its own `updates-*`
 *   thread (what a push tap opens) and the app shows them inline in the main chat. The digest is
 *   how the model knows what the owner sees there.
 * - `project-<id>`: one thread per project; its prompt carries the project's tasks and notes.
 *
 * Both are created on first use (GET /conversations/:id or POST /chat).
 */
export const MAIN_THREAD_ID = "main";
export const MAIN_THREAD_TITLE = "Talorys";
const PROJECT_PREFIX = "project-";

export function projectThreadId(projectId: string): string {
  return `${PROJECT_PREFIX}${projectId}`;
}

/** The project id of a project thread, or null. */
export function projectIdOfThread(conversationId: string): string | null {
  return conversationId.startsWith(PROJECT_PREFIX) ? conversationId.slice(PROJECT_PREFIX.length) || null : null;
}

/**
 * Creates the fixed thread when `conversationId` names one that does not exist yet. Returns false
 * for any other id (an ordinary or unknown conversation), true when the thread exists now.
 */
export function ensureFixedThread(services: Services, conversationId: string): boolean {
  if (conversationId === MAIN_THREAD_ID) {
    services.conversations.ensure(MAIN_THREAD_ID, MAIN_THREAD_TITLE);
    return true;
  }
  const projectId = projectIdOfThread(conversationId);
  if (projectId) {
    const project = services.projects.get(projectId);
    if (!project) return false;
    services.conversations.ensure(conversationId, project.name);
    return true;
  }
  return false;
}

const clip = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Notifications newer than this go into main's digest. */
export const DIGEST_WINDOW_MS = 3 * 86_400_000;

/** The live context section for a fixed thread, or null for ordinary conversations. */
export function threadContext(services: Services, conversationId: string, timezone: string, now = new Date()): string | null {
  if (conversationId === MAIN_THREAD_ID) return mainDigest(services, timezone, now);
  const projectId = projectIdOfThread(conversationId);
  if (projectId) return projectDigest(services, projectId, timezone);
  return null;
}

function mainDigest(s: Services, tz: string, now: Date): string {
  const when = (iso: string | null) => formatLocal(iso, tz) ?? "";
  const parts: string[] = [
    "This is the owner's main, continuous chat in the Talorys app. Notifications, reminders and automation results appear inline in this chat, so the owner may refer to them directly (\"what about that reminder?\"). Use the digest below to answer without asking what they mean.",
  ];

  const since = now.getTime() - DIGEST_WINDOW_MS;
  const notes = s.notifications.list({ limit: 12 }).filter((n) => Date.parse(n.created_at) >= since);
  if (notes.length) {
    parts.push(`Recent notifications sent to the owner (newest first):\n${notes.map((n) => `- ${when(n.created_at)} · ${clip(n.title, 80)}${n.body ? `: ${clip(n.body, 220)}` : ""}${n.read_at ? "" : " (unread)"}`).join("\n")}`);
  }

  const failed = s.automationsRepo.runs({ limit: 5, status: "error" }).filter((r) => Date.parse(r.started_at) >= since);
  if (failed.length) {
    parts.push(`Automation runs that failed recently:\n${failed.map((r) => `- ${r.automation_name} at ${when(r.started_at)}: ${clip(r.error ?? "error", 160)}`).join("\n")}`);
  }
  const upcoming = s.automationsRepo
    .list()
    .filter((a) => a.enabled && a.next_run)
    .sort((a, b) => (a.next_run! < b.next_run! ? -1 : 1))
    .slice(0, 6);
  if (upcoming.length) {
    parts.push(`Upcoming scheduled automations:\n${upcoming.map((a) => `- ${a.name} (${a.kind}) next at ${when(a.next_run)}`).join("\n")}`);
  }

  const bounds = localDayBounds(tz, now);
  const due = s.tasks.list({ view: "today", dayStart: bounds.start, dayEnd: bounds.end, limit: 15 });
  if (due.length) {
    parts.push(`Tasks due today or overdue:\n${due.map((t) => `- ${clip(t.title, 100)}${t.due_at ? ` (due ${when(t.due_at)})` : ""}${t.priority === "high" || t.priority === "urgent" ? ` · ${t.priority}` : ""}`).join("\n")}`);
  }

  const projects = s.projects.list().filter((p) => p.status === "active" || p.status === "paused").slice(0, 10);
  if (projects.length) {
    const lines = projects.map((p) => {
      const open = s.tasks.list({ status: "open", project_id: p.id, limit: 500 }).length;
      return `- ${clip(p.name, 80)} (${p.status}, ${open} open task(s))`;
    });
    parts.push(`Projects:\n${lines.join("\n")}`);
  }

  const suggestions = s.suggestions.list({ status: "new", limit: 5 });
  if (suggestions.length) {
    parts.push(`Open suggestions shown on the owner's Home screen:\n${suggestions.map((x) => `- ${clip(x.title, 100)}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

function projectDigest(s: Services, projectId: string, tz: string): string | null {
  const project = s.projects.get(projectId);
  if (!project) return null;
  const when = (iso: string | null) => formatLocal(iso, tz) ?? "";
  const parts: string[] = [
    `This chat is dedicated to the owner's project "${project.name}" (status: ${project.status}). Keep answers focused on it. New tasks and notes created here should belong to this project (project id ${project.id}).`,
  ];
  if (project.description.trim()) parts.push(`Project description:\n${clip(project.description, 1500)}`);
  const open = s.tasks.list({ status: "open", project_id: project.id, limit: 40 });
  parts.push(
    open.length
      ? `Open tasks:\n${open.map((t) => `- ${clip(t.title, 120)} [${t.status}, ${t.priority}]${t.due_at ? ` due ${when(t.due_at)}` : ""}`).join("\n")}`
      : "Open tasks: none.",
  );
  const done = s.tasks.list({ status: "done", project_id: project.id, limit: 10 });
  if (done.length) parts.push(`Recently completed:\n${done.map((t) => `- ${clip(t.title, 120)}`).join("\n")}`);
  const notes = s.notes.list({ project_id: project.id, limit: 12 });
  if (notes.length) parts.push(`Notes:\n${notes.map((n) => `- ${clip(n.title, 100)}: ${clip(n.content, 300)}`).join("\n")}`);
  return parts.join("\n\n");
}
