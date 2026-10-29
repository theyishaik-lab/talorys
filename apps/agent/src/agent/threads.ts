import type { Services } from "../services/container";
import { formatLocal, localDayBounds } from "../services/time";

/**
 * Fixed-id chat threads (the native app's single main chat and one chat per project).
 *
 * - `main`: the one continuous conversation. Its system prompt carries a compact live digest of what
 *   the agent has been doing elsewhere (the newest notifications, failed runs, counts of tasks due,
 *   projects and suggestions, with what is new since the model last saw it marked), so the owner
 *   never has to say "about that reminder you sent". Details come from tools on demand
 *   (src/tools/context.ts); long history is compacted into a running summary (context.ts).
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

/**
 * Size limits of the live digests. The digest is re-sent with every model step of every turn, so
 * it says what changed and points at tools for the details instead of dumping everything.
 */
export const DIGEST_LIMITS = {
  /** Hard cap on the main digest's length. */
  mainMaxChars: 1800,
  /** Newest notifications shown (title and a short excerpt); the rest are counted. */
  notifications: 3,
  notificationBodyChars: 120,
  failedRuns: 3,
  upcomingAutomations: 2,
  dueTasks: 3,
  projects: 6,
  suggestions: 2,
  /** Hard cap on a project chat's digest. */
  projectMaxChars: 3500,
  projectOpenTasks: 15,
  projectDoneTasks: 5,
  projectNotes: 8,
} as const;

/** Tools the digest points at, so the model fetches details on demand. */
export const DIGEST_TOOLS_HINT =
  "Details on demand: list_notifications, list_tasks, list_automations / automation_runs, list_projects / project_overview, list_suggestions, search_threads and read_thread (what was said in other chats: project chats, notification threads), search_memories.";

/**
 * The live context section for a fixed thread, or null for ordinary conversations. `since` is when
 * this thread's model last saw the digest; what is newer is marked new.
 */
export function threadContext(services: Services, conversationId: string, timezone: string, now = new Date(), since: string | null = null): string | null {
  if (conversationId === MAIN_THREAD_ID) return mainDigest(services, timezone, now, since);
  const projectId = projectIdOfThread(conversationId);
  if (projectId) return projectDigest(services, projectId, timezone);
  return null;
}

function capText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const nl = cut.lastIndexOf("\n");
  return `${nl > max * 0.6 ? cut.slice(0, nl) : cut}\n…`;
}

function mainDigest(s: Services, tz: string, now: Date, since: string | null): string {
  const L = DIGEST_LIMITS;
  const when = (iso: string | null) => formatLocal(iso, tz) ?? "";
  const isNew = (iso: string) => !!since && iso > since;
  const parts: string[] = [
    "This is the owner's main, continuous chat. Notifications, reminders and automation results appear inline here, so the owner may refer to them directly (\"what about that reminder?\"); use the digest and tools below instead of asking what they mean.",
  ];
  if (since) parts.push(`You last saw this digest at ${when(since)}; items marked (new) arrived since.`);

  const windowStart = now.getTime() - DIGEST_WINDOW_MS;
  const recent = s.notifications.list({ limit: 50 }).filter((n) => Date.parse(n.created_at) >= windowStart);
  if (recent.length) {
    const shown = recent.slice(0, L.notifications);
    const newCount = recent.filter((n) => isNew(n.created_at)).length;
    const unread = recent.filter((n) => !n.read_at).length;
    const lines = shown.map(
      (n) => `- ${when(n.created_at)} · ${clip(n.title, 70)}${n.body && n.body.trim() !== n.title.trim() ? `: ${clip(n.body, L.notificationBodyChars)}` : ""}${isNew(n.created_at) ? " (new)" : ""}`,
    );
    const more = recent.length - shown.length;
    parts.push(
      `Notifications (last 3 days: ${recent.length}, ${unread} unread${since ? `, ${newCount} new` : ""}), newest first:\n${lines.join("\n")}${more > 0 ? `\n- …and ${more} more (list_notifications)` : ""}`,
    );
  }

  const failed = s.automationsRepo.runs({ limit: 10, status: "error" }).filter((r) => Date.parse(r.started_at) >= windowStart);
  if (failed.length) {
    const shown = failed.slice(0, L.failedRuns);
    parts.push(
      `Failed automation runs (last 3 days: ${failed.length}):\n${shown.map((r) => `- ${clip(r.automation_name, 60)} at ${when(r.started_at)}: ${clip(r.error ?? "error", 100)}${isNew(r.started_at) ? " (new)" : ""}`).join("\n")}`,
    );
  }
  const upcoming = s.automationsRepo
    .list()
    .filter((a) => a.enabled && a.next_run)
    .sort((a, b) => (a.next_run! < b.next_run! ? -1 : 1));
  if (upcoming.length) {
    parts.push(`Next automations (${upcoming.length} scheduled): ${upcoming.slice(0, L.upcomingAutomations).map((a) => `${clip(a.name, 50)} at ${when(a.next_run)}`).join("; ")}`);
  }

  const bounds = localDayBounds(tz, now);
  const due = s.tasks.list({ view: "today", dayStart: bounds.start, dayEnd: bounds.end, limit: 50 });
  if (due.length) {
    parts.push(
      `Tasks due today or overdue: ${due.length} — ${due.slice(0, L.dueTasks).map((t) => `${clip(t.title, 60)}${t.priority === "high" || t.priority === "urgent" ? ` (${t.priority})` : ""}`).join("; ")}${due.length > L.dueTasks ? "; …" : ""}`,
    );
  }

  const projects = s.projects.list().filter((p) => p.status === "active" || p.status === "paused");
  if (projects.length) {
    parts.push(`Projects (${projects.length}): ${projects.slice(0, L.projects).map((p) => `${clip(p.name, 40)}${p.status === "paused" ? " (paused)" : ""}`).join(", ")}${projects.length > L.projects ? ", …" : ""}`);
  }

  const suggestions = s.suggestions.list({ status: "new", limit: 20 });
  if (suggestions.length) {
    parts.push(`Open suggestions on Home: ${suggestions.length} — ${suggestions.slice(0, L.suggestions).map((x) => clip(x.title, 60)).join("; ")}`);
  }
  parts.push(DIGEST_TOOLS_HINT);
  return capText(parts.join("\n\n"), L.mainMaxChars);
}

function projectDigest(s: Services, projectId: string, tz: string): string | null {
  const project = s.projects.get(projectId);
  if (!project) return null;
  const L = DIGEST_LIMITS;
  const when = (iso: string | null) => formatLocal(iso, tz) ?? "";
  const parts: string[] = [
    `This chat is dedicated to the owner's project "${project.name}" (status: ${project.status}). Keep answers focused on it. New tasks and notes created here should belong to this project (project id ${project.id}).`,
  ];
  if (project.description.trim()) parts.push(`Project description:\n${clip(project.description, 800)}`);
  const open = s.tasks.list({ status: "open", project_id: project.id, limit: 200 });
  parts.push(
    open.length
      ? `Open tasks (${open.length}):\n${open.slice(0, L.projectOpenTasks).map((t) => `- ${clip(t.title, 100)} [${t.status}, ${t.priority}]${t.due_at ? ` due ${when(t.due_at)}` : ""}`).join("\n")}${open.length > L.projectOpenTasks ? "\n- … (project_overview or list_tasks for the rest)" : ""}`
      : "Open tasks: none.",
  );
  const done = s.tasks.list({ status: "done", project_id: project.id, limit: L.projectDoneTasks });
  if (done.length) parts.push(`Recently completed: ${done.map((t) => clip(t.title, 60)).join("; ")}`);
  const notes = s.notes.list({ project_id: project.id, limit: L.projectNotes });
  if (notes.length) parts.push(`Notes (read_note for the full text):\n${notes.map((n) => `- ${clip(n.title, 80)} (${n.id}): ${clip(n.content, 120)}`).join("\n")}`);
  parts.push("Other chats (the main chat, notification threads) are reachable with search_threads and read_thread.");
  return capText(parts.join("\n\n"), L.projectMaxChars);
}
