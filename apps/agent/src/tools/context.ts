import { z } from "zod";
import { defineTool, ToolError } from "./registry";
import { presentTask } from "./tasks";
import { formatLocal } from "../services/time";
import { searchMessages, searchTerms, snippet } from "../db/message-search";
import { MAIN_THREAD_ID, projectIdOfThread } from "../agent/threads";

/**
 * On-demand context for long-lived chats: the main chat's digest names what changed and these
 * tools fetch the details, so the prompt stays small (src/agent/threads.ts, src/agent/context.ts).
 */

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** What kind of thread an id is, for the model. */
export function threadKind(id: string): "main" | "project" | "notifications" | "chat" {
  if (id === MAIN_THREAD_ID) return "main";
  if (projectIdOfThread(id)) return "project";
  if (id.startsWith("updates-")) return "notifications";
  return "chat";
}

export const contextTools = [
  defineTool({
    name: "list_notifications",
    description: "List notifications sent to the owner (reminders, automation results), newest first, with their full text.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({
      limit: z.number().int().min(1).max(30).optional(),
      unread_only: z.boolean().optional(),
      query: z.string().max(100).optional().describe("Only notifications whose title or text contains this"),
    }),
    label: () => "Checking notifications",
    execute: (i, ctx) => {
      const q = i.query?.trim().toLowerCase();
      const items = ctx.services.notifications
        .list({ unreadOnly: i.unread_only, limit: q ? 200 : (i.limit ?? 10) })
        .filter((n) => !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q))
        .slice(0, i.limit ?? 10);
      return {
        count: items.length,
        notifications: items.map((n) => ({
          id: n.id,
          title: n.title,
          body: clip(n.body, 1200),
          at: formatLocal(n.created_at, ctx.timezone),
          read: !!n.read_at,
          thread: n.automation_id ? `updates-${n.automation_id.replace(/[^A-Za-z0-9_-]/g, "")}` : "updates-inbox",
        })),
      };
    },
  }),
  defineTool({
    name: "automation_runs",
    description: "Recent runs of the owner's automations (scheduled checks, digests, reminders): when, status, result or error.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({ status: z.enum(["running", "success", "error", "skipped"]).optional(), limit: z.number().int().min(1).max(30).optional() }),
    label: () => "Checking automation runs",
    execute: (i, ctx) => ({
      runs: ctx.services.automationsRepo.runs({ status: i.status, limit: i.limit ?? 10 }).map((r) => ({
        automation: r.automation_name,
        status: r.status,
        at: formatLocal(r.started_at, ctx.timezone),
        ...(r.error ? { error: clip(r.error, 300) } : {}),
        ...(r.result ? { result: clip(r.result, 500) } : {}),
      })),
    }),
  }),
  defineTool({
    name: "project_overview",
    description: "One project in detail: description, open and recently completed tasks, notes and the latest messages of its chat.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ project: z.string().min(1).max(200).describe("Project name or id") }),
    label: (i) => `Opening project “${i.project}”`,
    execute: (i, ctx) => {
      const s = ctx.services;
      const p = s.projects.resolve(i.project);
      if (!p) throw new ToolError(`Project "${i.project}" does not exist. Use list_projects.`);
      const threadId = `project-${p.id}`;
      const thread = s.conversations.get(threadId);
      return {
        project: { id: p.id, name: p.name, status: p.status, description: clip(p.description, 1500) },
        open_tasks: s.tasks.list({ status: "open", project_id: p.id, limit: 50 }).map((t) => presentTask(t, ctx.timezone)),
        recently_done: s.tasks.list({ status: "done", project_id: p.id, limit: 10 }).map((t) => t.title),
        notes: s.notes.list({ project_id: p.id, limit: 20 }).map((n) => ({ id: n.id, title: n.title, excerpt: clip(n.content, 300) })),
        chat: thread
          ? {
              thread: threadId,
              ...(thread.summary ? { summary: thread.summary } : {}),
              latest: s.conversations.messages(threadId, { limit: 6 }).map((m) => ({ role: m.role, at: formatLocal(m.created_at, ctx.timezone), text: clip(m.content, 400) })),
            }
          : null,
      };
    },
  }),
  defineTool({
    name: "search_threads",
    description:
      "Search what was said in any chat: this one's older messages, project chats, notification threads and past conversations. Use it when the owner refers to something you cannot see in the current context.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({
      query: z.string().min(2).max(200),
      thread: z.string().max(120).optional().describe("Limit to one thread id (e.g. main, project-<id>, updates-inbox)"),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    label: (i) => `Searching chats for “${i.query}”`,
    execute: (i, ctx) => {
      const terms = searchTerms(i.query);
      const hits = searchMessages(ctx.services.db, i.query, { conversationId: i.thread, limit: i.limit ?? 8 });
      return {
        count: hits.length,
        results: hits.map((h) => ({
          thread: h.conversation_id,
          thread_title: h.conversation_title,
          kind: threadKind(h.conversation_id),
          role: h.role,
          at: formatLocal(h.created_at, ctx.timezone),
          excerpt: snippet(h.content, terms, 300),
          message_id: h.id,
        })),
        ...(hits.length === 0 ? { note: "Nothing matched. Try other words (or the other language the owner uses)." } : {}),
      };
    },
  }),
  defineTool({
    name: "read_thread",
    description:
      "Read another chat: its running summary and latest messages (or the messages around a time). Without a thread id, lists the most recently active chats.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({
      thread: z.string().max(120).optional(),
      limit: z.number().int().min(1).max(30).optional(),
      before_message_id: z.string().max(120).optional().describe("Read the messages up to this one (from search_threads)"),
    }),
    label: (i) => (i.thread ? `Reading chat ${i.thread}` : "Listing chats"),
    execute: (i, ctx) => {
      const s = ctx.services;
      if (!i.thread) {
        return {
          threads: s.conversations.list({ limit: i.limit ?? 15 }).map((c) => ({
            thread: c.id,
            title: c.title,
            kind: threadKind(c.id),
            updated: formatLocal(c.updated_at, ctx.timezone),
            messages: c.message_count,
          })),
        };
      }
      const conv = s.conversations.get(i.thread);
      if (!conv) throw new ToolError(`No chat "${i.thread}". Call read_thread without a thread to list them.`);
      const limit = i.limit ?? 12;
      let messages = s.conversations.messages(conv.id, { limit: i.before_message_id ? 2000 : limit });
      if (i.before_message_id) {
        const at = messages.findIndex((m) => m.id === i.before_message_id);
        if (at < 0) throw new ToolError("That message is not in this chat.");
        messages = messages.slice(Math.max(0, at - limit + 1), at + 2);
      }
      return {
        thread: conv.id,
        title: conv.title,
        kind: threadKind(conv.id),
        ...(conv.summary ? { summary_of_older_messages: conv.summary } : {}),
        messages: messages.map((m) => ({ id: m.id, role: m.role, at: formatLocal(m.created_at, ctx.timezone), text: clip(m.content, 800) })),
      };
    },
  }),
];
