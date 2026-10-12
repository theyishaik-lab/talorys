import { z } from "zod";
import { defineTool, quoteTitle, type ToolContext, type ToolDefinition } from "../tools/registry";
import { type OpenConnectorClient, truncateResult } from "./client";

const ACTION_ID = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9_]+\.[a-z0-9_]+$/i, "Use the full action id, e.g. gmail.search_threads");
const CONNECTION = z.string().trim().min(1).max(100).optional();
const INPUT = z.record(z.string(), z.unknown()).default({});

/** Leading verbs of action names that only read. Anything else is a change and needs the owner's approval. */
const READ_VERBS = new Set([
  "get", "list", "search", "fetch", "find", "read", "query", "lookup", "count", "check", "describe",
  "retrieve", "show", "view", "browse", "preview", "download", "export", "resolve", "validate", "verify", "ping",
]);

/** True when the action's name starts with a read verb (`gmail.search_threads`, `arxiv.get_paper`). */
export function isReadOnlyAction(actionId: string): boolean {
  const name = actionId.slice(actionId.lastIndexOf(".") + 1).toLowerCase();
  const verb = name.split("_")[0] ?? "";
  return READ_VERBS.has(verb);
}

interface ConnectionRow {
  service?: string;
  connectionName?: string;
  authType?: string;
  profile?: { displayName?: string; accountId?: string };
}

interface ActionRow {
  id?: string;
  description?: string;
  capability?: { execution?: { noAuthRunnable?: boolean; needsCredential?: boolean }; connection?: { configured?: boolean } };
  inputSummary?: { name?: string; required?: boolean; type?: string; description?: string }[];
}

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** One line per input, compact enough for a small model: `to (string, required): Recipient`. */
function inputLines(rows: ActionRow["inputSummary"]): string[] {
  return (rows ?? []).slice(0, 12).map((p) => `${p.name} (${p.type ?? "any"}${p.required ? ", required" : ""})${p.description ? `: ${p.description.slice(0, 120)}` : ""}`);
}

/** The owner-facing summary on the approval card: the action plus its main inputs. */
export function proposalSummary(action: string, input: Record<string, unknown>, connection?: string): string {
  const parts = Object.entries(input)
    .slice(0, 6)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? quoteTitle(v, 60) : JSON.stringify(v)?.slice(0, 60)}`);
  return `Run ${action}${connection ? ` (${connection})` : ""}${parts.length ? ` — ${parts.join(", ")}` : ""}`.slice(0, 400);
}

/** What a proposed run stores as its pending-action target: the exact call, replayed on approval. */
export interface ProposedRun {
  action: string;
  input: Record<string, unknown>;
  connection?: string;
}

/** Only the `## Input Parameters` part of an action guide; the rest is curl examples and policy text. */
export function guideInputs(markdown: string): string {
  const start = markdown.indexOf("## Input Parameters");
  if (start < 0) return markdown.slice(0, 1500);
  const rest = markdown.slice(start);
  const end = rest.search(/\n## (Required Scopes|Provider Permissions|Execution Policy)/);
  return (end > 0 ? rest.slice(0, end) : rest).trim().slice(0, 2500);
}

/**
 * The agent's tools for OpenConnector. Reads run at once; `propose_action` only proposes and runs
 * on the owner's Approve button like every other destructive tool, so sends, edits and deletes in
 * the owner's accounts never happen without them.
 */
export function openConnectorTools(client: OpenConnectorClient): ToolDefinition[] {
  return [
    defineTool({
      name: "connected_apps",
      description:
        "List the external apps and accounts connected through OpenConnector (email, calendar, Notion, GitHub, etc.) and which public services work without a login. Use it to answer which apps are connected or before choosing an action.",
      permission: "read",
      maxCallsPerTurn: 2,
      input: z.object({ service: z.string().trim().min(1).max(60).optional().describe("Optional service id to filter, e.g. gmail") }),
      label: (i) => (i.service ? `Checking the ${i.service} connection` : "Checking connected apps"),
      execute: async (i) => {
        const rows = asArray<ConnectionRow>(await client.data("list_connections", i.service ? { service: i.service } : {}));
        const connected = rows
          .filter((r) => r.authType && r.authType !== "no_auth")
          .map((r) => ({ service: r.service, connection: r.connectionName, account: r.profile?.displayName ?? r.profile?.accountId ?? "" }));
        const publicServices = rows.filter((r) => r.authType === "no_auth").map((r) => r.service).filter(Boolean);
        return {
          connected,
          public_services_without_login: publicServices.slice(0, 40),
          note:
            connected.length === 0
              ? "No app is connected with an account yet. The owner connects apps in the OpenConnector console; only public services work until then."
              : "Use search_actions with the service id to find what you can do with a connected app.",
        };
      },
    }),
    defineTool({
      name: "search_actions",
      description:
        "Search OpenConnector's catalog of actions on external apps (e.g. 'send email', 'calendar events', 'arxiv paper', 'notion page'). Returns action ids with their inputs. Do this before run_action or propose_action when you do not know the action id.",
      permission: "read",
      maxCallsPerTurn: 3,
      input: z.object({
        query: z.string().trim().min(1).max(200),
        service: z.string().trim().min(1).max(60).optional().describe("Optional service id such as gmail, github, notion, arxiv"),
      }),
      label: (i) => `Searching actions for ${quoteTitle(i.query, 40)}`,
      execute: async (i) => {
        const rows = asArray<ActionRow>(await client.data("search_actions", { query: i.query, ...(i.service ? { service: i.service } : {}), limit: 8 }));
        return {
          actions: rows.map((a) => ({
            id: a.id,
            description: a.description?.slice(0, 160),
            read_only: a.id ? isReadOnlyAction(a.id) : undefined,
            ready: a.capability?.execution?.noAuthRunnable === true || a.capability?.connection?.configured === true,
            inputs: inputLines(a.inputSummary),
          })),
          note: "read_only actions go through run_action; everything else through propose_action (the owner approves it). ready=false means the app is not connected yet.",
        };
      },
    }),
    defineTool({
      name: "action_guide",
      description: "Get the exact input parameters of one OpenConnector action by id, when search_actions did not show enough.",
      permission: "read",
      maxCallsPerTurn: 3,
      input: z.object({ action: ACTION_ID, connection: CONNECTION }),
      label: (i) => `Reading the guide for ${i.action}`,
      execute: async (i) => {
        const data = (await client.data("get_action_guide", { actionId: i.action, ...(i.connection ? { connectionName: i.connection } : {}) })) as {
          markdown?: string;
          capability?: { connection?: { configured?: boolean; profile?: { displayName?: string } } };
        };
        return {
          action: i.action,
          read_only: isReadOnlyAction(i.action),
          account: data.capability?.connection?.profile?.displayName ?? null,
          ready: data.capability?.connection?.configured ?? false,
          inputs: guideInputs(data.markdown ?? ""),
        };
      },
    }),
    defineTool({
      name: "run_action",
      description:
        "Run a read-only OpenConnector action now (ids whose name starts with get/list/search/fetch/find/read/query…), e.g. arxiv.get_paper or gmail.search_threads. Actions that send, create, update or delete must go through propose_action instead.",
      permission: "read",
      maxCallsPerTurn: 4,
      input: z.object({
        action: ACTION_ID,
        input: INPUT.describe("Input object exactly as the action guide describes"),
        connection: CONNECTION.describe("Named connection; omit for the default account"),
      }),
      label: (i) => `Running ${i.action}`,
      execute: async (i) => {
        if (!isReadOnlyAction(i.action)) {
          return {
            status: "needs_approval",
            note: `${i.action} changes data (it sends, creates, edits or deletes). Call propose_action with the same action and input; the owner will approve it in the app.`,
          };
        }
        return truncateResult(await client.data("execute_action", { actionId: i.action, input: i.input, ...(i.connection ? { connectionName: i.connection } : {}) }));
      },
    }),
    defineTool({
      name: "propose_action",
      description:
        "Propose an OpenConnector action that changes something in an external app (send an email, create a page or issue, update or delete a record). Nothing runs until the owner taps Approve in the app. Fill the input from the action guide first.",
      permission: "destructive",
      input: z.object({
        action: ACTION_ID,
        input: INPUT.describe("Input object exactly as the action guide describes"),
        connection: CONNECTION.describe("Named connection; omit for the default account"),
      }),
      label: (i) => `Proposing ${i.action}`,
      prepare: (i) => {
        const run: ProposedRun = { action: i.action, input: i.input, ...(i.connection ? { connection: i.connection } : {}) };
        return { targetId: JSON.stringify(run), summary: proposalSummary(run.action, run.input, run.connection) };
      },
      commit: async (targetId, ctx: ToolContext) => {
        const run = JSON.parse(targetId) as ProposedRun;
        const summary = proposalSummary(run.action, run.input, run.connection);
        const data = await client.data("execute_action", { actionId: run.action, input: run.input, ...(run.connection ? { connectionName: run.connection } : {}) });
        const excerpt = JSON.stringify(truncateResult(data, 600)) ?? "";
        ctx.services.activity.record("connector.action", summary);
        ctx.services.notifications.create({ title: "Done", body: `${summary}\n\nResult: ${excerpt.slice(0, 700)}` });
        return data;
      },
    }),
  ] as ToolDefinition[];
}
