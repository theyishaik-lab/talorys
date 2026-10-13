import type { ConnectCard, PendingAction } from "@talorys/shared";
import { AppError, NotFoundError } from "../api/errors";
import type { z } from "zod";
import type { Services } from "../services/container";

export type ToolPermission = "read" | "write" | "destructive";

export interface ToolContext {
  services: Services;
  timezone: string;
  /** "chat" for interactive turns; "scheduled" for automation runs (read-only + notify). */
  mode: "chat" | "scheduled";
  /** The chat conversation, which owns any destructive actions proposed during the turn. */
  conversationId?: string;
}

/** The exact target of a destructive call, resolved before anything changes. */
export interface PreparedAction {
  targetId: string;
  /** Shown to the owner on the approval card, e.g. `Delete task “Buy milk”`. */
  summary: string;
  /** A richer owner-facing card than Approve/Decline (connecting an app). */
  card?: ConnectCard;
  /** What the model is told instead of the generic "the owner sees an Approve button" note. */
  note?: string;
}

/** What `commit` may return to update the owner's card after the action ran (the consent link, the account). */
export interface CommitResult {
  card?: ConnectCard;
}

/**
 * Values the owner typed on the approval card (a connect card's key fields). They reach `commit`
 * straight from the approve request and are never stored, logged or shown to the model.
 */
export type SubmittedValues = Record<string, string>;

interface BaseTool<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  /** Max invocations of this tool in a single turn (in addition to the global budget). */
  maxCallsPerTurn?: number;
  /** Short human-readable label for the UI, e.g. "Adding task “Buy milk”". */
  label: (input: z.infer<S>) => string;
}

export interface ImmediateTool<S extends z.ZodType = z.ZodType, R = unknown> extends BaseTool<S> {
  permission: "read" | "write";
  execute: (input: z.infer<S>, ctx: ToolContext) => R | Promise<R>;
}

/**
 * A destructive tool never runs during the agent's turn. `prepare` resolves the target
 * without changing anything; `commit` runs only after the owner approves that exact action.
 */
export interface DestructiveTool<S extends z.ZodType = z.ZodType> extends BaseTool<S> {
  permission: "destructive";
  prepare: (input: z.infer<S>, ctx: ToolContext) => PreparedAction | Promise<PreparedAction>;
  commit: (targetId: string, ctx: ToolContext, submitted?: SubmittedValues) => unknown;
}

export type ToolDefinition<S extends z.ZodType = z.ZodType, R = unknown> = ImmediateTool<S, R> | DestructiveTool<S>;

export function defineTool<S extends z.ZodType, R>(def: ToolDefinition<S, R>): ToolDefinition<S, R> {
  return def;
}

/** Quotes a title for an approval summary, shortened so the card stays readable. */
export function quoteTitle(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return `“${clean.length > max ? `${clean.slice(0, max - 1)}…` : clean}”`;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/**
 * A tool could not run because the outside app it needs is not connected yet (seen live Oct 13,
 * 2026: an approved `googletasks.insert_task` failed with "Connect googletasks with OAuth first"
 * and the model told the owner it was done). The executor turns this into a connect card plus a
 * plain instruction to the model; on an approved action the card shows `message` as the reason.
 */
export class NotConnectedError extends ToolError {
  constructor(
    /** The connector's service id, e.g. `googletasks`. */
    public readonly service: string,
    /** The app's display name, e.g. `Google Tasks`. */
    public readonly appName: string,
  ) {
    super(`${appName} is not connected yet.`);
    this.name = "NotConnectedError";
  }
}

/** The tool that proposes connecting an app, when the connector's admin side is configured. */
export const CONNECT_TOOL = "connect_service";

export interface ExecutorLimits {
  maxToolCalls: number;
}

/**
 * Executes tools for one agent turn with validation, permission checks,
 * a global call budget, per-tool caps and duplicate-call (loop) detection.
 */
export class ToolExecutor {
  private calls = 0;
  private readonly perTool = new Map<string, number>();
  private readonly signatures = new Map<string, number>();
  /** Approval requests created this turn, by provider tool-call id. */
  private readonly approvals = new Map<string, PendingAction>();
  /** Connect cards this turn already proposed for an app that turned out not to be connected, by service. */
  private readonly connectCards = new Map<string, PendingAction>();

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly ctx: ToolContext,
    private readonly limits: ExecutorLimits,
  ) {}

  get callCount(): number {
    return this.calls;
  }

  budgetExhausted(): boolean {
    return this.calls >= this.limits.maxToolCalls;
  }

  /** Tools permitted in this context. Scheduled runs never get write or destructive tools. */
  available(): ToolDefinition[] {
    if (this.limits.maxToolCalls <= 0) return [];
    return this.tools.filter((t) => this.ctx.mode === "chat" || t.permission === "read" || t.name === "notify_owner");
  }

  find(name: string): ToolDefinition | undefined {
    return this.available().find((t) => t.name === name);
  }

  approvalFor(callId: string): PendingAction | undefined {
    return this.approvals.get(callId);
  }

  async execute(name: string, rawInput: unknown, callId?: string): Promise<unknown> {
    const tool = this.find(name);
    if (!tool) throw new ToolError(`Tool "${name}" is not available.`);
    if (this.calls >= this.limits.maxToolCalls) {
      throw new ToolError("Tool call limit reached for this request. Answer the owner with the information you already have.");
    }
    const used = this.perTool.get(name) ?? 0;
    if (tool.maxCallsPerTurn !== undefined && used >= tool.maxCallsPerTurn) {
      throw new ToolError(`"${name}" was already used ${used} times in this request. Do not call it again.`);
    }
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ToolError(`Invalid input${issue ? ` at "${issue.path.join(".")}": ${issue.message}` : ""}.`);
    }
    const signature = `${name}:${stableStringify(parsed.data)}`;
    const repeats = this.signatures.get(signature) ?? 0;
    if (repeats >= 1) {
      throw new ToolError("This exact call was already made in this request. Use the earlier result instead of repeating it.");
    }
    this.calls++;
    this.perTool.set(name, used + 1);
    this.signatures.set(signature, repeats + 1);
    try {
      return await this.run(tool, parsed.data, callId);
    } catch (error) {
      if (error instanceof NotConnectedError) throw await this.notConnected(error, callId);
      throw error;
    }
  }

  private async run(tool: ToolDefinition, input: unknown, callId?: string): Promise<unknown> {
    if (tool.permission !== "destructive") return await tool.execute(input, this.ctx);

    if (!this.ctx.conversationId) throw new ToolError(`"${tool.name}" needs the owner's approval and can only be used in chat.`);
    const prepared = await tool.prepare(input, this.ctx);
    const action = this.ctx.services.pendingActions.create({
      conversation_id: this.ctx.conversationId,
      tool: tool.name,
      target_id: prepared.targetId,
      summary: prepared.summary,
      ...(prepared.card ? { card: prepared.card } : {}),
    });
    if (callId) this.approvals.set(callId, action);
    return {
      status: "awaiting_owner_approval",
      action: prepared.summary,
      note:
        prepared.note ??
        "Nothing has changed yet. The owner now sees an Approve button for exactly this action. Briefly tell them what you proposed. Do not call this tool again for the same item and do not claim it is done.",
    };
  }

  /**
   * What the model hears when an app is not connected: nothing ran, and — when the connect tool is
   * available in this chat — a card to connect the app is attached to this very call, so the owner
   * can connect it right here. The model is told to say so plainly and never to claim success.
   */
  private async notConnected(error: NotConnectedError, callId?: string): Promise<ToolError> {
    const { service, appName } = error;
    const nothingRan = `${appName} (${service}) is not connected to this assistant yet, so the action did not run and nothing was done.`;
    const sayIt = `Tell the owner plainly, in their language, that ${appName} is not connected yet. Never say the task was done. Do not ask for a key or password in the chat, and do not retry the action in this turn.`;
    const connect = this.find(CONNECT_TOOL);
    if (!connect || connect.permission !== "destructive" || !this.ctx.conversationId) {
      return new ToolError(`${nothingRan} ${sayIt}${connect ? "" : " Connecting apps is not available here; the owner connects it in the connector console."}`);
    }
    const shown = this.connectCards.get(service);
    if (shown) return new ToolError(`${nothingRan} The card to connect ${appName} is already shown in this reply. ${sayIt}`);
    let prepared: PreparedAction;
    try {
      prepared = await connect.prepare({ service }, this.ctx);
    } catch (cause) {
      const reason = cause instanceof ToolError ? cause.message : `The connect card could not be prepared.`;
      return new ToolError(`${nothingRan} ${reason} ${sayIt}`);
    }
    const action = this.ctx.services.pendingActions.create({
      conversation_id: this.ctx.conversationId,
      tool: connect.name,
      target_id: prepared.targetId,
      summary: prepared.summary,
      ...(prepared.card ? { card: prepared.card } : {}),
    });
    this.connectCards.set(service, action);
    if (callId) this.approvals.set(callId, action);
    return new ToolError(
      `${nothingRan} A card to connect ${appName} now appears right under this step: the owner approves it there and signs in or pastes the key on the card. Tell the owner, in one or two sentences in their language, that ${appName} is not connected yet, that they can connect it on the card below, and that you will do what they asked once it is connected. Never say the task was done. Do not ask for a key or password in the chat, and do not retry the action in this turn.`,
    );
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

/**
 * Runs a destructive action the owner approved in the UI. The pending record is claimed
 * atomically first, so each action runs at most once, and only on the target that was shown.
 */
export async function runApprovedAction(tools: ToolDefinition[], ctx: ToolContext, actionId: string, submitted?: SubmittedValues): Promise<PendingAction> {
  const pending = ctx.services.pendingActions;
  const stored = pending.get(actionId);
  if (!stored) throw new NotFoundError("This action no longer exists.");
  const tool = tools.find((t) => t.name === stored.tool);
  if (tool?.permission !== "destructive") throw new NotFoundError("This action no longer exists.");
  if (!pending.resolve(actionId, "approved")) {
    const status = pending.view(actionId)?.status;
    throw new AppError("CONFLICT", status === "expired" ? "This request expired. Ask again to get a new one." : "This action was already handled.");
  }
  try {
    const result = (await tool.commit(stored.target_id, ctx, submitted)) as CommitResult | undefined;
    if (result && typeof result === "object" && result.card) pending.setCard(actionId, result.card);
  } catch (error) {
    pending.markFailed(actionId, error instanceof ToolError ? error.message : "The action failed.");
    if (!(error instanceof ToolError)) console.error("Approved action failed", error);
  }
  return pending.view(actionId)!;
}
