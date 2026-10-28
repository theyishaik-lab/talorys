import type { AiAttribution, ApiErrorCode, ChatMessage, ChatStreamEvent, Conversation, ToolActivity } from "@talorys/shared";
import { ApiError, api, streamChat } from "./api";
import { createStore, type Store } from "./store";

/**
 * Chat state for one open conversation.
 *
 * `messages` changes only when a message starts or finishes; the text of the reply being streamed
 * lives in `stream`, so each token re-renders one row, never the list.
 */
export interface StreamState {
  messageId: string;
  text: string;
  tools: ToolActivity[];
  error: string | null;
  /** The error's code, when the agent sent one. */
  errorCode?: ApiErrorCode | null;
  /** Which model is answering (a backup, from a `model` event) or whose failure ended the turn (agent 0.1.13+). */
  ai?: AiAttribution | null;
  /** The connection dropped; the reply is being fetched from history (the server finishes it anyway). */
  recovering?: boolean;
}

export interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  loading: boolean;
  loadError: string | null;
  /** Non-null while a reply is being generated. */
  streamingId: string | null;
  quotaExceeded: { message: string } | null;
  /** The conversation's title, once loaded (thread headers show it). */
  title?: string;
}

export const conversationsStore = createStore<Conversation[]>([]);

export interface ChatStores {
  chat: Store<ChatState>;
  stream: Store<StreamState | null>;
  /** The in-flight request (Stop aborts it); travels with the stores to the chat's own screen. */
  controller: { current: AbortController | null };
}

/**
 * Stores of turns still in flight, by conversation. A new chat moves to its own route as soon as the
 * agent names the conversation; the new screen picks up these same stores, so the reply keeps
 * streaming there. (v0.1.1 aborted the request when the first screen unmounted, and the agent then
 * threw the answer away.)
 */
const inFlight = new Map<string, ChatStores>();

export function createChatStores(conversationId: string | null): ChatStores {
  const live = conversationId ? inFlight.get(conversationId) : undefined;
  if (live) return live;
  const chat = createStore<ChatState>({ conversationId, messages: [], loading: !!conversationId, loadError: null, streamingId: null, quotaExceeded: null });
  const stream = createStore<StreamState | null>(null);
  return { chat, stream, controller: { current: null } };
}

/** True while these stores carry a reply in progress (streaming or being recovered). */
export function isInFlight(stores: ChatStores): boolean {
  return stores.chat.get().streamingId !== null;
}

export async function refreshConversations(): Promise<void> {
  const { conversations } = await api<{ conversations: Conversation[] }>("/conversations");
  conversationsStore.set(conversations);
}

export async function loadConversation(stores: ChatStores, id: string): Promise<void> {
  stores.chat.set((s) => ({ ...s, loading: true, loadError: null }));
  try {
    const { conversation, messages, streaming } = await api<{ conversation: Conversation; messages: ChatMessage[]; streaming?: boolean }>(`/conversations/${id}`);
    stores.chat.set((s) => ({ ...s, conversationId: id, messages, loading: false, title: conversation?.title }));
    // A reply still being written (e.g. the app was closed mid-answer): show it when it lands.
    if (streaming && !isInFlight(stores)) void recoverReply(stores, id);
  } catch (error) {
    stores.chat.set((s) => ({ ...s, loading: false, loadError: error instanceof Error ? error.message : "Failed" }));
  }
}

export const RECOVER_POLL_MS = 2_000;
export const RECOVER_MAX_MS = 4 * 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The connection dropped but the agent finishes the turn anyway: poll the conversation until the
 * reply is saved, then show the history (keeping any message of ours the agent never accepted).
 * Returns true when the reply arrived.
 */
export async function recoverReply(stores: ChatStores, conversationId: string, opts: { pollMs?: number; maxMs?: number } = {}): Promise<boolean> {
  const pollMs = opts.pollMs ?? RECOVER_POLL_MS;
  const deadline = Date.now() + (opts.maxMs ?? RECOVER_MAX_MS);
  stores.chat.set((s) => ({ ...s, streamingId: s.streamingId ?? "recovering" }));
  stores.stream.set((st) => (st ? { ...st, recovering: true } : { messageId: "recovering", text: "", tools: [], error: null, recovering: true }));
  inFlight.set(conversationId, stores);
  try {
    for (;;) {
      try {
        const { messages, streaming } = await api<{ messages: ChatMessage[]; streaming?: boolean }>(`/conversations/${conversationId}`);
        if (!streaming) {
          stores.chat.set((s) => ({ ...s, conversationId, messages: mergeHistory(messages, s.messages), streamingId: null }));
          stores.stream.set(null);
          return true;
        }
      } catch {
        /* still offline: keep trying until the deadline */
      }
      if (Date.now() + pollMs > deadline) break;
      await sleep(pollMs);
    }
    stores.chat.set((s) => ({ ...s, streamingId: null }));
    stores.stream.set((st) => (st ? { ...st, recovering: false, error: st.error ?? "NETWORK" } : st));
    finishStream(stores, false);
    return false;
  } finally {
    if (inFlight.get(conversationId) === stores) inFlight.delete(conversationId);
  }
}

/** Server history, plus our own bubbles the server never accepted (they carry an error). */
export function mergeHistory(server: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const known = new Set(server.map((m) => m.id));
  return [...server, ...local.filter((m) => m.id.startsWith("local-") && m.error && !known.has(m.id))];
}

const QUOTA_CODES = new Set(["AI_QUOTA_EXCEEDED", "RATE_LIMITED", "AI_UNAVAILABLE"]);
function looksLikeQuota(code: string, message: string): boolean {
  return QUOTA_CODES.has(code) || /quota|allowance|limit|neurons|429|מכסה/i.test(message);
}

/** Applies one SSE event to the stores. Exported so the reducer is unit-testable without a network. */
export function applyStreamEvent(stores: ChatStores, event: ChatStreamEvent, onConversation?: (id: string) => void): void {
  switch (event.type) {
    case "start": {
      const now = new Date().toISOString();
      stores.chat.set((s) => {
        const messages = s.messages.slice();
        // The optimistic user bubble gets its real id.
        const idx = messages.findIndex((m) => m.id.startsWith("local-"));
        if (idx >= 0) messages[idx] = { ...messages[idx]!, id: event.user_message_id, conversation_id: event.conversation_id };
        return { ...s, conversationId: event.conversation_id, messages, streamingId: event.assistant_message_id, quotaExceeded: null };
      });
      stores.stream.set({ messageId: event.assistant_message_id, text: "", tools: [], error: null });
      void now;
      onConversation?.(event.conversation_id);
      break;
    }
    case "text":
      stores.stream.set((st) => (st ? { ...st, text: st.text + event.delta } : st));
      break;
    case "tool":
      stores.stream.set((st) => {
        if (!st) return st;
        const tools = st.tools.slice();
        const i = tools.findIndex((t) => t.id === event.tool.id);
        if (i >= 0) tools[i] = event.tool;
        else tools.push(event.tool);
        return { ...st, tools };
      });
      break;
    case "title":
      conversationsStore.set((list) => list.map((c) => (c.id === event.conversation_id ? { ...c, title: event.title } : c)));
      break;
    case "model":
      stores.stream.set((st) => (st ? { ...st, ai: { provider: event.provider, model: event.model, fallback: true, attempts: event.attempts ?? [] } } : st));
      break;
    case "error": {
      const quota = looksLikeQuota(event.code, event.message);
      const ai: AiAttribution | null =
        event.provider && event.model ? { provider: event.provider, model: event.model, fallback: (event.attempts?.length ?? 0) > 1, attempts: event.attempts ?? [] } : null;
      stores.stream.set((st) => (st ? { ...st, error: event.message, errorCode: event.code, ai: ai ?? st.ai ?? null } : st));
      if (quota) stores.chat.set((s) => ({ ...s, quotaExceeded: { message: event.message } }));
      break;
    }
    case "done": {
      stores.chat.set((s) => ({ ...s, messages: [...s.messages.filter((m) => m.id !== event.message.id), event.message], streamingId: null }));
      stores.stream.set(null);
      break;
    }
  }
}

/** Turns what is left of the stream into a message in the list (a stop, a drop, an error). */
function finishStream(stores: ChatStores, aborted: boolean): void {
  const st = stores.stream.get();
  if (!st) return;
  const partial: ChatMessage = {
    id: st.messageId === "pending" || st.messageId === "recovering" ? `local-reply-${Date.now()}` : st.messageId,
    conversation_id: stores.chat.get().conversationId ?? "",
    role: "assistant",
    content: st.text,
    tools: st.tools,
    status: aborted ? "cancelled" : "error",
    error: st.error,
    created_at: new Date().toISOString(),
    ...(st.errorCode ? { error_code: st.errorCode } : {}),
    ...(st.ai ? { ai: st.ai } : {}),
  };
  stores.chat.set((s) => ({ ...s, messages: st.text || st.tools.length || st.error ? [...s.messages, partial] : s.messages, streamingId: null }));
  stores.stream.set(null);
}

/** Sends a message; the optimistic user bubble appears at once, the reply streams into `stream`. */
export async function sendMessage(stores: ChatStores, text: string, controller: AbortController, onConversation?: (id: string) => void): Promise<void> {
  const state = stores.chat.get();
  stores.controller.current = controller;
  const localId = `local-${Date.now()}`;
  const local: ChatMessage = {
    id: localId,
    conversation_id: state.conversationId ?? "",
    role: "user",
    content: text,
    tools: [],
    status: "complete",
    error: null,
    created_at: new Date().toISOString(),
  };
  stores.chat.set((s) => ({ ...s, messages: [...s.messages, local], streamingId: "pending", quotaExceeded: null }));
  stores.stream.set({ messageId: "pending", text: "", tools: [], error: null });
  let conversationId = state.conversationId;
  let finished = false;
  let recover = false;
  try {
    await streamChat(
      { conversation_id: state.conversationId ?? undefined, message: text },
      (e) => {
        if (e.type === "start") {
          conversationId = e.conversation_id;
          // Registered before the screen hears about the conversation, so its new route finds these stores.
          inFlight.set(e.conversation_id, stores);
        }
        if (e.type === "done") finished = true;
        applyStreamEvent(stores, e, onConversation);
      },
      controller.signal,
    );
    // The stream closed without "done": the connection ended early, the turn is still running.
    if (!finished && !controller.signal.aborted && conversationId) recover = true;
  } catch (error) {
    if (controller.signal.aborted) {
      /* Stop: finishStream below keeps what arrived */
    } else {
      const message = error instanceof Error ? error.message : "Failed";
      const code = error instanceof ApiError ? error.code : "";
      if (code === "CONFLICT") {
        // The agent is still on the previous message: ours was not accepted. Say so on our bubble,
        // and bring in the previous answer when it lands.
        stores.chat.set((s) => ({ ...s, messages: s.messages.map((m) => (m.id === localId ? { ...m, error: "CONFLICT" } : m)) }));
        stores.stream.set(null);
        if (conversationId) recover = true;
        else stores.chat.set((s) => ({ ...s, streamingId: null }));
      } else if (conversationId && (code === "NETWORK" || !(error instanceof ApiError))) {
        // A dropped connection mid-turn (on Android: "Software caused connection abort"). The agent
        // finishes the turn and saves it; fetch it from history instead of showing a raw error.
        stores.stream.set((st) => (st ? { ...st, error: message } : { messageId: "pending", text: "", tools: [], error: message }));
        recover = true;
      } else {
        const quota = looksLikeQuota(code, message);
        stores.chat.set((s) => ({ ...s, quotaExceeded: quota ? { message } : s.quotaExceeded }));
        stores.stream.set((st) => (st ? { ...st, error: code || message } : { messageId: "pending", text: "", tools: [], error: code || message }));
      }
    }
  } finally {
    if (stores.controller.current === controller) stores.controller.current = null;
    if (recover && conversationId) {
      await recoverReply(stores, conversationId);
    } else {
      finishStream(stores, controller.signal.aborted);
      if (conversationId && inFlight.get(conversationId) === stores) inFlight.delete(conversationId);
    }
  }
}

export async function cancelGeneration(stores: ChatStores, controller: AbortController): Promise<void> {
  controller.abort();
  const id = stores.chat.get().conversationId;
  if (id) await api("/chat/cancel", { method: "POST", body: { conversation_id: id } }).catch(() => {});
}

/** Replaces the approval status on the tool that carries it (after Approve / Decline). */
export function updateTool(stores: ChatStores, messageId: string, tool: ToolActivity): void {
  stores.chat.set((s) => ({
    ...s,
    messages: s.messages.map((m) => (m.id === messageId ? { ...m, tools: m.tools.map((t) => (t.id === tool.id ? tool : t)) } : m)),
  }));
}

export type { Store };
