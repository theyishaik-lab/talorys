import { type ChatStreamEvent, chatRequestSchema, formatAttempts, conversationCreateSchema, conversationUpdateSchema } from "@talorys/shared";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../app";
import { body, query } from "../middleware";
import { AppError, NotFoundError } from "../errors";
import { runApprovedAction, ToolError } from "../../tools";
import { connectionStatus, openConnectorAdmin, openConnectorClient, refreshConnectLink } from "../../openconnector";
import { ensureFixedThread } from "../../agent/threads";
import { publicConversation } from "../../db/repositories/conversations";

export const chatRoutes = new Hono<AppEnv>();

chatRoutes.get("/conversations", (c) => {
  const { q } = query(c, z.object({ q: z.string().max(200).optional() }));
  return c.json({ conversations: c.env.agent.services.conversations.list({ q }) });
});

chatRoutes.post("/conversations", async (c) => {
  const { title } = await body(c, conversationCreateSchema);
  return c.json({ conversation: publicConversation(c.env.agent.services.conversations.create(title || "New conversation")) }, 201);
});

/**
 * One conversation with its messages. The fixed threads (`main`, the native app's single chat, and
 * `project-<id>`) are created on first read, so GET /conversations/main always answers.
 */
chatRoutes.get("/conversations/:id", (c) => {
  const s = c.env.agent.services;
  ensureFixedThread(s, c.req.param("id"));
  const conversation = s.conversations.require(c.req.param("id"));
  return c.json({
    conversation: publicConversation(conversation),
    messages: s.pendingActions.withCurrentStatus(s.conversations.messages(conversation.id)),
    streaming: conversationBusy(c.env.agent.activeRuns, conversation.id),
  });
});

chatRoutes.patch("/conversations/:id", async (c) => {
  const { title } = await body(c, conversationUpdateSchema);
  return c.json({ conversation: publicConversation(c.env.agent.services.conversations.rename(c.req.param("id"), title)) });
});

chatRoutes.delete("/conversations/:id", (c) => {
  const id = c.req.param("id");
  c.env.agent.activeRuns.get(id)?.abort();
  c.env.agent.services.conversations.delete(id);
  return c.json({ deleted: true });
});

chatRoutes.delete("/conversations", async (c) => {
  await body(c, z.object({ confirm: z.literal("DELETE") }));
  for (const controller of c.env.agent.activeRuns.values()) controller.abort();
  const deleted = c.env.agent.services.conversations.deleteAll();
  c.env.agent.services.activity.record("privacy.history_cleared", `Deleted ${deleted} conversation(s)`);
  return c.json({ deleted });
});

/** A comment frame sent while the model is silent, so phones and proxies never see an idle stream. */
export const HEARTBEAT_MS = 10_000;
/**
 * A run that has produced nothing for this long is stuck (the first-word watchdog moves a silent
 * model to the backup after 15 s), so its claim on the conversation no longer blocks a new message.
 */
export const STALE_RUN_MS = 150_000;
const lastProgress = new WeakMap<AbortController, number>();

/** True when the conversation has a live run; a stale claim is aborted and released instead. */
export function conversationBusy(activeRuns: Map<string, AbortController>, conversationId: string, now = Date.now()): boolean {
  const run = activeRuns.get(conversationId);
  if (!run) return false;
  const last = lastProgress.get(run);
  if (last !== undefined && now - last < STALE_RUN_MS) return true;
  if (last === undefined) return true;
  run.abort();
  activeRuns.delete(conversationId);
  return false;
}

/** Records that a run did something (for the stale-claim check). Exported for tests. */
export function markProgress(controller: AbortController, at = Date.now()): void {
  lastProgress.set(controller, at);
}

/**
 * Streams one agent turn as Server-Sent Events. The stream is produced inside the
 * Durable Object and passes unbuffered through the Worker and the Pages Function.
 *
 * The turn belongs to the conversation, not to the connection: if the client goes away (a phone
 * changing networks, the app moving to a new screen) the run still finishes and saves the answer,
 * which the client then reads from history. Only POST /chat/cancel (the Stop button) ends a run early.
 */
chatRoutes.post("/chat", async (c) => {
  const input = await body(c, chatRequestSchema, 64 * 1024);
  const agent = c.env.agent;
  if (input.conversation_id && conversationBusy(agent.activeRuns, input.conversation_id)) {
    throw new AppError("CONFLICT", "A response is already being generated in this conversation.");
  }
  const controller = new AbortController();
  markProgress(controller);
  // Claim the conversation now, before any await, so a concurrent request sees the conflict.
  if (input.conversation_id) agent.activeRuns.set(input.conversation_id, controller);
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let clientGone = false;

  // Writes are never awaited: a reader that stopped reading must not stall the turn (that kept the
  // conversation claimed forever). Order is kept by the writer's own queue.
  const write = (frame: string) => {
    if (clientGone) return;
    writer.write(encoder.encode(frame)).catch(() => {
      clientGone = true;
    });
  };
  const send = (event: ChatStreamEvent) => write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => write(`: ping\n\n`), HEARTBEAT_MS);

  const run = async () => {
    let conversationId: string | undefined = input.conversation_id;
    try {
      write(`: stream open\n\n`);
      for await (const event of agent.runner().chat({
        conversationId: input.conversation_id,
        message: input.message,
        retry: input.retry,
        signal: controller.signal,
      })) {
        markProgress(controller);
        if (event.type === "start") {
          conversationId = event.conversation_id;
          agent.activeRuns.set(conversationId, controller);
        }
        send(event);
      }
    } catch (error) {
      const appError = error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "Something went wrong.");
      if (!(error instanceof AppError)) console.error("Chat turn failed", error);
      send({ type: "error", code: appError.code, message: appError.message, details: appError.details });
    } finally {
      clearInterval(heartbeat);
      if (conversationId && agent.activeRuns.get(conversationId) === controller) agent.activeRuns.delete(conversationId);
      writer.close().catch(() => {
        /* already closed or the client is gone */
      });
    }
  };
  // The Durable Object stays alive while the response stream is open.
  void run();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
});

/** How long POST /chat/sync waits for a turn before it answers with what it has. */
export const SYNC_TIMEOUT_MS = 60_000;

/**
 * Non-streaming chat endpoint for mobile/embedded clients that cannot consume SSE (the Android
 * keyboard's Ask sheet). Runs a full chat turn and returns the final assistant text as JSON.
 *
 * Oct 30, 2026: a turn that failed (every model in the chain refused) used to come back as
 * `200 {"reply":""}`, so the keyboard could only say "empty reply" and never why. A failed turn
 * with no text is now an error response with the agent's error envelope (503 for model failures,
 * 429 for the daily limit), whose details carry the models tried and why each failed. A follow-up
 * may pass the `conversation_id` it got back to continue the same conversation instead of
 * starting a new one per message.
 *
 * Capped at [SYNC_TIMEOUT_MS]; returns the partial text if the turn is still running at timeout.
 */
chatRoutes.post("/chat/sync", async (c) => {
  const input = await body(
    c,
    z.object({
      message: z.string().min(1).max(8192),
      context: z.string().max(500).optional(),
      conversation_id: z.string().min(1).max(64).optional(),
    }),
  );

  const agent = c.env.agent;
  if (input.conversation_id && conversationBusy(agent.activeRuns, input.conversation_id)) {
    throw new AppError("CONFLICT", "A response is already being generated in this conversation.");
  }
  const controller = new AbortController();
  markProgress(controller);
  if (input.conversation_id) agent.activeRuns.set(input.conversation_id, controller);
  const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);

  const fullMessage = input.context ? `[Context: ${input.context}]\n\n${input.message}` : input.message;
  let replyText = "";
  let finalText = "";
  let conversationId: string | undefined = input.conversation_id;
  let failure: Extract<ChatStreamEvent, { type: "error" }> | null = null;
  let model: string | null = null;

  try {
    for await (const event of agent.runner().chat({
      conversationId: input.conversation_id,
      message: fullMessage,
      signal: controller.signal,
    })) {
      markProgress(controller);
      if (event.type === "start") {
        conversationId = event.conversation_id;
        agent.activeRuns.set(conversationId, controller);
      } else if (event.type === "text") replyText += event.delta ?? "";
      else if (event.type === "error") failure = event;
      else if (event.type === "model") model = event.model;
      else if (event.type === "done") finalText = event.message.content ?? "";
    }
  } catch (error) {
    // Thrown before the turn started (e.g. an unknown conversation_id): the normal error response.
    if (error instanceof AppError) throw error;
    console.error("chat/sync turn failed", error);
    failure = { type: "error", code: "INTERNAL_ERROR", message: "Something went wrong." };
  } finally {
    clearTimeout(timeout);
    if (conversationId && agent.activeRuns.get(conversationId) === controller) agent.activeRuns.delete(conversationId);
  }

  const reply = replyText.trim() ? replyText : failure ? "" : finalText;
  if (!reply.trim()) {
    const timedOut = controller.signal.aborted;
    const code = failure?.code ?? (timedOut ? "AI_UNAVAILABLE" : "INTERNAL_ERROR");
    const message = failure?.message ?? (timedOut ? `No answer within ${SYNC_TIMEOUT_MS / 1000} s. Please try again.` : "The agent returned no answer.");
    const attempts = failure?.attempts ?? [];
    throw new AppError(code, message, {
      conversation_id: conversationId ?? null,
      ...(attempts.length ? { attempts, attempts_text: formatAttempts(attempts) } : {}),
      ...(failure?.provider ? { provider: failure.provider, model: failure.model, status: failure.status ?? null, reason: failure.reason } : {}),
      ...(timedOut && !failure ? { timeout_s: SYNC_TIMEOUT_MS / 1000 } : {}),
    });
  }
  return c.json({
    reply,
    conversation_id: conversationId ?? null,
    ...(model ? { model } : {}),
    // Text arrived, then the turn failed: the partial answer plus why it stopped.
    ...(failure ? { error: { code: failure.code, message: failure.message } } : {}),
  });
});

chatRoutes.post("/chat/cancel", async (c) => {
  const { conversation_id } = await body(c, z.object({ conversation_id: z.string().min(1).max(64) }));
  const controller = c.env.agent.activeRuns.get(conversation_id);
  controller?.abort();
  return c.json({ cancelled: !!controller });
});

/**
 * Owner approval of a destructive action the agent proposed. The agent has no way to call this.
 * `values` carries what the owner typed on a connect card (an API key); it goes to the tool's
 * commit and nowhere else — not into the database, the chat, or a log line.
 */
const approveSchema = z.object({ values: z.record(z.string().max(100), z.string().max(4096)).optional() });
chatRoutes.post("/actions/:id/approve", async (c) => {
  const s = c.env.agent.services;
  const { values } = await body(c, approveSchema);
  const action = await runApprovedAction(c.env.agent.approvalTools(), { services: s, timezone: s.settings.get().timezone, mode: "chat" }, c.req.param("id"), values);
  return c.json({ action });
});

/** A fresh sign-in link for an approved connect action (the connector's OAuth state lives 15 minutes). */
chatRoutes.post("/actions/:id/link", async (c) => {
  const admin = openConnectorAdmin(c.env.env);
  if (!admin) throw new NotFoundError("No connector is configured.");
  const s = c.env.agent.services;
  const id = c.req.param("id");
  if (!s.pendingActions.get(id)) throw new NotFoundError("This action no longer exists.");
  try {
    return c.json({ url: await refreshConnectLink(admin, { services: s, timezone: s.settings.get().timezone, mode: "chat" }, id) });
  } catch (error) {
    if (error instanceof ToolError) throw new AppError("CONFLICT", error.message);
    throw error;
  }
});

/** Whether an external app is connected right now; a connect card polls it after an OAuth sign-in. */
chatRoutes.get("/connections/:service", async (c) => {
  const client = openConnectorClient(c.env.env);
  if (!client) throw new NotFoundError("No connector is configured.");
  const service = c.req.param("service");
  if (!/^[a-z0-9_]{2,60}$/i.test(service)) throw new NotFoundError("Unknown service.");
  return c.json(await connectionStatus(client, service));
});

chatRoutes.post("/actions/:id/cancel", (c) => {
  const pending = c.env.agent.services.pendingActions;
  const id = c.req.param("id");
  if (!pending.get(id)) throw new NotFoundError("This action no longer exists.");
  pending.resolve(id, "cancelled");
  return c.json({ action: pending.view(id) });
});
