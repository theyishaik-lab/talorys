import type { ChatStreamEvent } from "@talorys/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Oct 13, 2026, v0.1.1 on Yishai's Pixel: "Software caused connection abort" on every message,
 * then "A response is already being generated". The app now (1) never kills its own stream when a
 * new chat moves to its route, (2) fetches the finished answer from history after a drop, and
 * (3) explains a busy conversation instead of showing the agent's English error.
 */
const net = vi.hoisted(() => ({
  stream: null as null | ((payload: unknown, onEvent: (e: ChatStreamEvent) => void, signal: AbortSignal) => Promise<void>),
  history: [] as Array<{ messages: unknown[]; streaming: boolean }>,
  calls: [] as string[],
}));

vi.mock("../src/lib/api", async (orig) => {
  const real = await orig<typeof import("../src/lib/api")>();
  return {
    ...real,
    streamChat: (p: unknown, on: (e: ChatStreamEvent) => void, s: AbortSignal) => net.stream!(p, on, s),
    api: async (path: string) => {
      net.calls.push(path);
      const next = net.history.length > 1 ? net.history.shift()! : net.history[0]!;
      return next;
    },
  };
});

const { ApiError } = await import("../src/lib/api");
const { createChatStores, recoverReply, sendMessage } = await import("../src/lib/chat");
const { chatErrorKey } = await import("../src/lib/errors");

const msg = (id: string, role: "user" | "assistant", content: string, extra: Record<string, unknown> = {}) => ({
  id,
  conversation_id: "c1",
  role,
  content,
  tools: [],
  status: "complete",
  error: null,
  created_at: "2026-10-13T13:14:43.000Z",
  ...extra,
});
const start: ChatStreamEvent = { type: "start", conversation_id: "c1", user_message_id: "u1", assistant_message_id: "a1" };

beforeEach(() => {
  net.history = [];
  net.calls = [];
});

describe("a new chat hands its live reply to the chat's own screen", () => {
  it("the screen opened for the new conversation gets the same stores, still streaming", async () => {
    const home = createChatStores(null);
    let handedOver: ReturnType<typeof createChatStores> | null = null;
    net.stream = async (_p, on) => {
      on(start);
      on({ type: "text", delta: "שלום" });
      on({ type: "done", message: msg("a1", "assistant", "שלום") as never });
    };
    await sendMessage(home, "Hi", new AbortController(), (id) => {
      // What router.replace does: the conversation's screen creates its stores now.
      handedOver = createChatStores(id);
      expect(handedOver.stream.get()).not.toBeNull();
    });
    expect(handedOver).toBe(home);
    expect(home.chat.get().messages.map((m) => `${m.role}:${m.content}`)).toEqual(["user:Hi", "assistant:שלום"]);
    // Once finished, a later visit loads fresh stores from history.
    expect(createChatStores("c1")).not.toBe(home);
  });
});

describe("after a dropped connection the answer comes from history", () => {
  it("Android's 'Software caused connection abort' mid-stream → polls, then shows the saved answer", async () => {
    const stores = createChatStores("c1");
    stores.chat.set((s) => ({ ...s, loading: false }));
    net.stream = async (_p, on) => {
      on(start);
      throw new Error("Software caused connection abort");
    };
    net.history = [
      { messages: [msg("u1", "user", "Hi")], streaming: true },
      { messages: [msg("u1", "user", "Hi"), msg("a1", "assistant", "היי! מה שלומך?")], streaming: false },
    ];
    const seen: boolean[] = [];
    const unsub = stores.stream.subscribe(() => seen.push(!!stores.stream.get()?.recovering));
    await sendMessageFast(stores, "Hi");
    unsub();
    // While polling, the row said "getting the answer" instead of a red error.
    expect(seen).toContain(true);
    expect(stores.chat.get().messages.map((m) => `${m.role}:${m.content}`)).toEqual(["user:Hi", "assistant:היי! מה שלומך?"]);
    expect(stores.chat.get().streamingId).toBeNull();
    expect(stores.stream.get()).toBeNull();
    expect(net.calls.filter((c) => c === "/conversations/c1").length).toBe(2);
  });

  it("a stream that just ends without 'done' is recovered the same way", async () => {
    const stores = createChatStores("c1");
    net.stream = async (_p, on) => {
      on(start);
      on({ type: "text", delta: "חלקי" });
    };
    net.history = [{ messages: [msg("u1", "user", "מה המצב?"), msg("a1", "assistant", "הכול טוב")], streaming: false }];
    await sendMessageFast(stores, "מה המצב?");
    expect(stores.chat.get().messages.map((m) => m.content)).toEqual(["מה המצב?", "הכול טוב"]);
  });

  it("gives up after the deadline with a friendly network error, not a raw one", async () => {
    const stores = createChatStores("c1");
    net.history = [{ messages: [msg("u1", "user", "Hi")], streaming: true }];
    const ok = await recoverReply(stores, "c1", { pollMs: 1, maxMs: 5 });
    expect(ok).toBe(false);
    const last = stores.chat.get().messages.at(-1)!;
    expect(last.status).toBe("error");
    expect(chatErrorKey(last.error)).toBe("chat.err.network");
  });
});

describe("a busy conversation", () => {
  it("CONFLICT marks our bubble as not sent and brings in the previous answer", async () => {
    const stores = createChatStores("c1");
    stores.chat.set((s) => ({ ...s, loading: false, messages: [msg("u0", "user", "מה המצב?") as never] }));
    net.stream = async () => {
      throw new ApiError(409, "CONFLICT", "A response is already being generated in this conversation.");
    };
    net.history = [{ messages: [msg("u0", "user", "מה המצב?"), msg("a0", "assistant", "הכול טוב")], streaming: false }];
    await sendMessageFast(stores, "מה קרה");
    const list = stores.chat.get().messages;
    expect(list.map((m) => m.content)).toEqual(["מה המצב?", "הכול טוב", "מה קרה"]);
    expect(chatErrorKey(list.at(-1)!.error)).toBe("chat.err.busy");
  });
});

describe("friendly errors", () => {
  it.each([
    ["Software caused connection abort", "chat.err.network"],
    ["unexpected end of stream on https://x/...", "chat.err.network"],
    ["NETWORK", "chat.err.network"],
    ["A response is already being generated in this conversation.", "chat.err.busy"],
    ["Talorys reached its daily limit of 200 AI requests (adjustable in Settings → AI).", "chat.err.dailyLimit"],
    ["Google Gemini is having trouble right now. Please try again in a moment.", "chat.err.unavailable"],
    ["Something went wrong.", "chat.err.generic"],
  ])("%s → %s", (text, key) => {
    expect(chatErrorKey(text)).toBe(key);
  });
  it("leaves unknown text alone", () => {
    expect(chatErrorKey("Some tool-specific explanation")).toBeNull();
  });
});

/** sendMessage with the recovery poll shortened (fake timers would also freeze the stream). */
async function sendMessageFast(stores: ReturnType<typeof createChatStores>, text: string) {
  vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 50 });
  try {
    const p = sendMessage(stores, text, new AbortController());
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(2_000);
    await p;
  } finally {
    vi.useRealTimers();
  }
}
