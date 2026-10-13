import { z } from "zod";
import { defineTool, NotConnectedError, quoteTitle, ToolError, type ToolContext, type ToolDefinition } from "../tools/registry";
import { serviceDisplayName } from "./services";
import { type OpenConnectorClient, isPlatformLimitError, servicesHintedBy, truncateResult } from "./client";

const ACTION_ID = z
  .string()
  .trim()
  .min(3)
  .max(120)
  .regex(/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/i, "Use the full action id, e.g. gmail.search_threads or googledrive.files.list");
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

/** A catalog row from the plain `GET /v1/actions` endpoints: a JSON schema instead of an input summary. */
interface CatalogActionRow {
  id?: string;
  service?: string;
  name?: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { type?: string; description?: string }>; required?: string[] };
}

/** Input lines from a JSON schema, the shape `GET /v1/actions/<id>` answers with. */
/**
 * Google Calendar event actions whose `calendarId` OpenConnector's schema marks required while its
 * description says "omit to use the primary calendar". Models take the description at its word and
 * every call fails schema validation (seen live Oct 13, 2026 on gemma-4: four 400s, then an apology).
 * Only event-level actions get the default; calendar- and ACL-level ones (clear, delete a calendar…)
 * must name their calendar, and actions without the field would reject an extra property.
 */
const PRIMARY_CALENDAR_ACTIONS = new Set(
  [
    "list_events",
    "list_event_instances",
    "sync_events",
    "find_event",
    "get_event",
    "create_event",
    "quick_add_event",
    "import_event",
    "update_event",
    "patch_event",
    "move_event",
    "delete_event",
    "add_attendee",
    "remove_attendee",
  ].map((name) => `googlecalendar.${name}`),
);

/** Fills inputs the catalog promises a default for but still validates as required. */
export function withActionDefaults(action: string, input: Record<string, unknown>): Record<string, unknown> {
  if (PRIMARY_CALENDAR_ACTIONS.has(action.toLowerCase())) {
    const id = input.calendarId;
    if (id === undefined || id === null || (typeof id === "string" && id.trim() === "")) return { ...input, calendarId: "primary" };
  }
  return input;
}

export function schemaInputLines(schema: CatalogActionRow["inputSchema"]): string[] {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {})
    .slice(0, 12)
    .map(([name, p]) => `${name} (${p?.type ?? "any"}${required.has(name) ? ", required" : ""})${p?.description ? `: ${p.description.slice(0, 120)}` : ""}`);
}

/** Ranks per-service catalog rows against the query words: id and description hits, read verbs first on ties. */
export function rankCatalogRows(rows: CatalogActionRow[], query: string, limit = 8): CatalogActionRow[] {
  const words = query.toLowerCase().split(/[^a-z0-9\u0590-\u05ff]+/).filter((w) => w.length > 1);
  const score = (r: CatalogActionRow) => {
    const id = (r.id ?? "").toLowerCase();
    const desc = (r.description ?? "").toLowerCase();
    let s = 0;
    for (const w of words) {
      if (id.includes(w)) s += 3;
      else if (desc.includes(w)) s += 1;
    }
    if (r.id && isReadOnlyAction(r.id)) s += 0.5;
    return s;
  };
  return rows
    .map((r) => ({ r, s: score(r) }))
    .filter((x) => x.s > 0 || words.length === 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.r);
}

/**
 * The cheap search: per-service catalog listings instead of the fuzzy index. OpenConnector's
 * `search_actions` builds a MiniSearch index over all ~15k actions on first use, which the free
 * Workers plan cuts off at 10 ms CPU when the call comes from this Worker (Oct 13, 2026).
 */
async function searchViaCatalog(client: OpenConnectorClient, query: string, service: string | undefined, connectedServices: () => Promise<string[]>) {
  const services = service ? [service] : [...new Set([...servicesHintedBy(query), ...(await connectedServices())])].slice(0, 4);
  const rows: CatalogActionRow[] = [];
  for (const s of services) {
    try {
      rows.push(...(asArray<CatalogActionRow>(await client.get(`/v1/actions?service=${encodeURIComponent(s)}`))));
    } catch {
      // one service's listing failing should not hide the others
    }
  }
  return { services, rows: rankCatalogRows(rows, query) };
}

/**
 * Refuses to propose an action on an app that is not connected: the connector would only refuse
 * it after the owner's Approve tap (seen live Oct 13, 2026 — an approved Google Tasks insert failed
 * on the card and the model called it done). An empty connection list for the service is the
 * refusal; a public (no-login) service lists its virtual connection, and a failed or odd answer
 * from the connector is not treated as "not connected" — the run itself will say.
 */
export async function assertServiceConnected(client: OpenConnectorClient, action: string): Promise<void> {
  const service = action.slice(0, action.indexOf(".")).toLowerCase();
  if (!service) return;
  let rows: unknown;
  try {
    rows = await client.data("list_connections", { service });
  } catch {
    return;
  }
  if (Array.isArray(rows) && rows.length === 0) throw new NotConnectedError(service, serviceDisplayName(service));
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
        let rows: ConnectionRow[];
        let serviceNote = "";
        try {
          rows = asArray<ConnectionRow>(await client.data("list_connections", i.service ? { service: i.service } : {}));
        } catch (error) {
          if (!i.service || !/unknown_service|unknown service/i.test(error instanceof Error ? error.message : String(error))) throw error;
          rows = asArray<ConnectionRow>(await client.data("list_connections", {}));
          serviceNote = `"${i.service}" is not a service id; the ids are listed below (Google Drive is googledrive, Google Calendar is googlecalendar). `;
        }
        const connected = rows
          .filter((r) => r.authType && r.authType !== "no_auth")
          .map((r) => ({ service: r.service, connection: r.connectionName, account: r.profile?.displayName ?? r.profile?.accountId ?? "" }));
        const publicServices = rows.filter((r) => r.authType === "no_auth").map((r) => r.service).filter(Boolean);
        // Asked about one app that has no connection at all: hand the executor a connect card for it.
        const asked = i.service && !serviceNote ? i.service.trim().toLowerCase() : "";
        const missing = asked && rows.length === 0 && /^[a-z0-9_]{2,60}$/.test(asked) ? { service: asked, name: serviceDisplayName(asked) } : undefined;
        return {
          connected,
          public_services_without_login: publicServices.slice(0, 40),
          ...(missing ? { connect_card: missing } : {}),
          note:
            serviceNote +
            (connected.length === 0
              ? "No app is connected with an account yet; only public services work until then. To add one, use connect_service (the owner approves on a card)."
              : "Use search_actions with the service id to find what you can do with a connected app. An app that is not listed can be added with connect_service."),
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
        let rows: ActionRow[];
        try {
          rows = asArray<ActionRow>(await client.data("search_actions", { query: i.query, ...(i.service ? { service: i.service } : {}), limit: 8 }));
        } catch (error) {
          if (!isPlatformLimitError(error) && /runtime token/.test(error instanceof Error ? error.message : "")) throw error;
          const fallback = await searchViaCatalog(client, i.query, i.service, async () =>
            asArray<ConnectionRow>(await client.data("list_connections", {}))
              .map((c) => c.service ?? "")
              .filter((s) => s && !["arxiv", "hackernews", "npm", "pubmed"].includes(s)),
          );
          if (!fallback.rows.length) {
            throw new ToolError(
              `The catalog search is unavailable right now and no actions matched in ${fallback.services.join(", ") || "the connected apps"}. Try search_actions with a service id (gmail, googlecalendar, googledrive, github) or use action_guide with a known action id.`,
            );
          }
          return {
            actions: fallback.rows.map((a) => ({
              id: a.id,
              description: a.description?.slice(0, 160),
              read_only: a.id ? isReadOnlyAction(a.id) : undefined,
              ready: true,
              inputs: schemaInputLines(a.inputSchema),
            })),
            note: `Matched from the ${fallback.services.join(", ")} catalog. read_only actions go through run_action; everything else through propose_action (the owner approves it).`,
          };
        }
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
        let data: { markdown?: string; capability?: { connection?: { configured?: boolean; profile?: { displayName?: string } } } };
        try {
          data = (await client.data("get_action_guide", { actionId: i.action, ...(i.connection ? { connectionName: i.connection } : {}) })) as typeof data;
        } catch (error) {
          if (!isPlatformLimitError(error)) throw error;
          const row = (await client.get(`/v1/actions/${encodeURIComponent(i.action)}`)) as CatalogActionRow;
          return { action: i.action, read_only: isReadOnlyAction(i.action), account: null, ready: null, inputs: schemaInputLines(row.inputSchema), note: "Inputs read from the catalog; whether the app is connected is in connected_apps." };
        }
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
        const input = withActionDefaults(i.action, i.input);
        return truncateResult(await client.data("execute_action", { actionId: i.action, input, ...(i.connection ? { connectionName: i.connection } : {}) }));
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
      prepare: async (i) => {
        await assertServiceConnected(client, i.action);
        const run: ProposedRun = { action: i.action, input: withActionDefaults(i.action, i.input), ...(i.connection ? { connection: i.connection } : {}) };
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
