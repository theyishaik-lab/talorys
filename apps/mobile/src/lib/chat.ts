import type { ChatMessage, ChatStreamEvent, Conversation, ToolActivity } from "@talorys/shared";
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
}

export interface ChatState {
  conversationId: string | null;
  messages: ChatMessage[];
  loading: boolean;
  loadError: string | null;
  /** Non-null while a reply is being generated. */
  streamingId: string | null;
  quotaExceeded: { message: string } | null;
}

export const conversationsStore = createStore<Conversation[]>([]);

export function createChatStores(conversationId: string | null) {
  const chat = createStore<ChatState>({ conversationId, messages: [], loading: !!conversationId, loadError: null, streamingId: null, quotaExceeded: null });
  const stream = createStore<StreamState | null>(null);
  return { chat, stream };
}
export type ChatStores = ReturnType<typeof createChatStores>;

export async function refreshConversations(): Promise<void> {
  const { conversations } = await api<{ conversations: Conversation[] }>("/conversations");
  conversationsStore.set(conversations);
}

export async function loadConversation(stores: ChatStores, id: string): Promise<void> {
  stores.chat.set((s) => ({ ...s, loading: true, loadError: null }));
  try {
    const { messages } = await api<{ conversation: Conversation; messages: ChatMessage[] }>(`/conversations/${id}`);
    stores.chat.set((s) => ({ ...s, conversationId: id, messages, loading: false }));
  } catch (error) {
    stores.chat.set((s) => ({ ...s, loading: false, loadError: error instanceof Error ? error.message : "Failed" }));
  }
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
    case "error": {
      const quota = looksLikeQuota(event.code, event.message);
      stores.stream.set((st) => (st ? { ...st, error: event.message } : st));
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

/** Sends a message; the optimistic user bubble appears at once, the reply streams into `stream`. */
export async function sendMessage(stores: ChatStores, text: string, controller: AbortController, onConversation?: (id: string) => void): Promise<void> {
  const state = stores.chat.get();
  const local: ChatMessage = {
    id: `local-${Date.now()}`,
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
  try {
    await streamChat({ conversation_id: state.conversationId ?? undefined, message: text }, (e) => applyStreamEvent(stores, e, onConversation), controller.signal);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed";
    const code = error instanceof ApiError ? error.code : "";
    const quota = looksLikeQuota(code, message);
    stores.chat.set((s) => ({ ...s, quotaExceeded: quota ? { message } : s.quotaExceeded }));
    stores.stream.set((st) => (st ? { ...st, error: message } : { messageId: "pending", text: "", tools: [], error: message }));
  } finally {
    // If the stream ended without a "done" (abort, network), keep what arrived as a message.
    const st = stores.stream.get();
    if (st) {
      const partial: ChatMessage = {
        id: st.messageId === "pending" ? `local-reply-${Date.now()}` : st.messageId,
        conversation_id: stores.chat.get().conversationId ?? "",
        role: "assistant",
        content: st.text,
        tools: st.tools,
        status: controller.signal.aborted ? "cancelled" : "error",
        error: st.error,
        created_at: new Date().toISOString(),
      };
      stores.chat.set((s) => ({ ...s, messages: st.text || st.tools.length || st.error ? [...s.messages, partial] : s.messages, streamingId: null }));
      stores.stream.set(null);
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
