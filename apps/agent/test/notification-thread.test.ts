import { describe, expect, it } from "vitest";
import { buildContextWindow } from "../src/agent/memory";
import { notificationMessage, notificationThreadId } from "../src/services/container";

const msg = (i: number, role: "user" | "assistant", content = `m${i}`) => ({
  id: String(i), conversation_id: "updates-inbox", role, content, tools: [], status: "complete" as const, error: null,
  created_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
});

describe("notification threads", () => {
  it("routes notifications to a fixed, URL-safe thread", () => {
    expect(notificationThreadId(null)).toBe("updates-inbox");
    expect(notificationThreadId("a1b2-c3")).toBe("updates-a1b2-c3");
    expect(notificationThreadId("x/y?z")).toBe("updates-xyz");
  });

  it("writes title and full body", () => {
    expect(notificationMessage("Digest", "line 1\nline 2")).toBe("**Digest**\n\nline 1\nline 2");
    expect(notificationMessage("Reminder", "")).toBe("**Reminder**");
  });

  it("keeps leading notifications in context behind a framing user turn", () => {
    const win = buildContextWindow([msg(0, "assistant", "your digest"), msg(1, "user", "what about task 2?")], 10_000, null);
    expect(win.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(win.messages[1]!.content).toBe("your digest");
  });

  it("still drops a dangling assistant turn in an ordinary chat", () => {
    const history = [msg(0, "user"), msg(1, "assistant", "x".repeat(4000)), msg(2, "assistant"), msg(3, "user")];
    const win = buildContextWindow(history, 30, null);
    expect(win.messages[0]!.role).toBe("user");
    expect(win.messages[0]!.content).not.toContain("notifications");
  });
});
