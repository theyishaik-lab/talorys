import { describe, expect, it } from "vitest";
import { applyStreamEvent, conversationsStore, createChatStores, updateTool } from "../src/lib/chat";

const message = (over: Record<string, unknown> = {}) => ({
  id: "a1",
  conversation_id: "c1",
  role: "assistant" as const,
  content: "done",
  tools: [],
  status: "complete" as const,
  error: null,
  created_at: "2026-10-13T10:00:00.000Z",
  ...over,
});

describe("streaming reducer", () => {
  it("keeps tokens out of the message list until done", () => {
    const stores = createChatStores(null);
    stores.chat.set((s) => ({ ...s, messages: [{ ...message({ id: "local-1", role: "user", content: "hi" }) }], streamingId: "pending" }));
    const listBefore = stores.chat.get().messages;
    applyStreamEvent(stores, { type: "start", conversation_id: "c1", user_message_id: "u1", assistant_message_id: "a1" });
    expect(stores.chat.get().messages[0]!.id).toBe("u1");
    expect(stores.chat.get().conversationId).toBe("c1");
    const listAfterStart = stores.chat.get().messages;
    applyStreamEvent(stores, { type: "text", delta: "שלום " });
    applyStreamEvent(stores, { type: "text", delta: "ישי" });
    // Tokens changed only the stream store; the list reference is untouched (no list re-render).
    expect(stores.chat.get().messages).toBe(listAfterStart);
    expect(listBefore).not.toBe(listAfterStart);
    expect(stores.stream.get()?.text).toBe("שלום ישי");
    applyStreamEvent(stores, { type: "tool", tool: { id: "t1", name: "x", label: "Reading tasks", status: "running" } });
    applyStreamEvent(stores, { type: "tool", tool: { id: "t1", name: "x", label: "Read tasks", status: "success" } });
    expect(stores.stream.get()?.tools).toEqual([{ id: "t1", name: "x", label: "Read tasks", status: "success" }]);
    applyStreamEvent(stores, { type: "done", message: message({ content: "שלום ישי" }) });
    expect(stores.stream.get()).toBeNull();
    expect(stores.chat.get().streamingId).toBeNull();
    expect(stores.chat.get().messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("flags a spent allowance so the chat can point to Settings → Model", () => {
    const stores = createChatStores("c1");
    stores.stream.set({ messageId: "a1", text: "", tools: [], error: null });
    applyStreamEvent(stores, { type: "error", code: "INTERNAL_ERROR", message: "Workers AI daily allowance (neurons) exhausted" });
    expect(stores.chat.get().quotaExceeded?.message).toContain("allowance");
    expect(stores.stream.get()?.error).toContain("allowance");
  });

  it("renames the conversation in the drawer list on a title event", () => {
    conversationsStore.set([{ id: "c1", title: "New conversation", created_at: "", updated_at: "" }]);
    const stores = createChatStores("c1");
    applyStreamEvent(stores, { type: "title", conversation_id: "c1", title: "קניות" });
    expect(conversationsStore.get()[0]!.title).toBe("קניות");
  });

  it("replaces the approval on the right tool after Approve", () => {
    const stores = createChatStores("c1");
    const tool = { id: "t1", name: "delete", label: "Delete task", status: "success" as const, approval: { id: "p1", summary: "Delete task “x”", status: "pending" as const, error: null, expires_at: "" } };
    stores.chat.set((s) => ({ ...s, messages: [message({ tools: [tool] })] }));
    updateTool(stores, "a1", { ...tool, approval: { ...tool.approval, status: "approved" } });
    expect(stores.chat.get().messages[0]!.tools[0]!.approval?.status).toBe("approved");
  });
});
