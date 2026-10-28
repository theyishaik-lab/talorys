import { describe, expect, it } from "vitest";
import { NotificationGate, appNavigatorMounted, canRoute, hrefOf, notificationTarget, targetOf, threadOf } from "../src/lib/notificationRouting";

const BASE = "https://talorys-lxl5w9o0-web.pages.dev";

describe("which thread a push is about", () => {
  it("reads the new `thread` key first (agent 0.3.1+), then conversation_id, then the url", () => {
    expect(threadOf({ thread: "updates-inbox", url: `${BASE}/chat?thread=updates-inbox` })).toBe("updates-inbox");
    expect(threadOf({ conversation_id: "updates-a1", url: `${BASE}/chat/updates-a1` })).toBe("updates-a1");
    expect(threadOf({ url: `${BASE}/chat/updates-a1#action-x` })).toBe("updates-a1");
    expect(threadOf({ url: `${BASE}/chat?thread=project-p1#action-x` })).toBe("project-p1");
  });
  it("nothing to open for the older bell link, a settings link or junk", () => {
    expect(threadOf({ url: `${BASE}/chat?notifications=1` })).toBeUndefined();
    expect(threadOf({ url: `${BASE}/settings` })).toBeUndefined();
    expect(threadOf({ thread: "../../etc" })).toBeUndefined();
    expect(threadOf({ thread: 42 })).toBeUndefined();
    expect(threadOf(undefined)).toBeUndefined();
  });
  it("targetOf keeps its old shape", () => {
    expect(targetOf({ thread: "updates-inbox", action_id: "a1" })).toEqual({ conversationId: "updates-inbox", actionId: "a1" });
  });
  it("maps main → Chat tab, project-* → project screen, anything else → a thread", () => {
    expect(notificationTarget({ thread: "main" })).toEqual({ kind: "chat" });
    expect(notificationTarget({ thread: "project-p1" })).toEqual({ kind: "project", id: "p1" });
    expect(notificationTarget({ thread: "updates-inbox" })).toEqual({ kind: "thread", id: "updates-inbox" });
    expect(notificationTarget({ url: "/settings" })).toBeNull();
    expect(hrefOf({ kind: "chat" })).toBe("/chat");
    expect(hrefOf({ kind: "thread", id: "updates-inbox" })).toEqual({ pathname: "/chat/[id]", params: { id: "updates-inbox" } });
    expect(hrefOf({ kind: "project", id: "p1" })).toEqual({ pathname: "/projects/[id]", params: { id: "p1" } });
  });
});

describe("when a tap may navigate", () => {
  // expo-router's internal outer stack, with the app's root Stack not mounted (every screen still
  // behind a false Stack.Protected guard): routing now pushed a second `__root` — the 0.2.3 loop.
  const outerOnly = { index: 0, routes: [{ name: "__root" }] };
  const mounted = { index: 0, routes: [{ name: "__root", state: { index: 0, routes: [{ name: "(main)" }] } }] };

  it("not before the app navigator is mounted", () => {
    expect(appNavigatorMounted(undefined)).toBe(false);
    expect(appNavigatorMounted(outerOnly)).toBe(false);
    expect(appNavigatorMounted({ index: 0, routes: [{ name: "+not-found" }] })).toBe(false);
    expect(appNavigatorMounted(mounted)).toBe(true);
  });
  it("only when the session is read and signed in", () => {
    expect(canRoute({ ready: false, authenticated: false }, mounted)).toBe(false);
    expect(canRoute({ ready: false, authenticated: true }, mounted)).toBe(false);
    expect(canRoute({ ready: true, authenticated: false }, mounted)).toBe(false);
    expect(canRoute({ ready: true, authenticated: true }, outerOnly)).toBe(false);
    expect(canRoute({ ready: true, authenticated: true }, mounted)).toBe(true);
  });
});

describe("each notification is handled once", () => {
  it("the listener and getLastNotificationResponse reporting the same tap → one navigation", () => {
    const g = new NotificationGate();
    expect(g.admit("n1", 0)).toBe(true);
    expect(g.admit("n1", 10)).toBe(false); // getLast returns it again (after a remount, too)
    expect(g.admit("n2", 20)).toBe(true);
  });
  it("persisted ids survive a restart", () => {
    const g = new NotificationGate();
    g.preload(["n1"]);
    expect(g.admit("n1", 0)).toBe(false);
    expect(g.ids()).toEqual(["n1"]);
  });
  it("a burst of navigations trips the breaker for good", () => {
    const g = new NotificationGate({ burst: 3, windowMs: 10_000 });
    expect(g.admit("a", 0)).toBe(true);
    expect(g.admit("b", 1)).toBe(true);
    expect(g.admit("c", 2)).toBe(true);
    expect(g.admit("d", 3)).toBe(false);
    expect(g.tripped).toBe(true);
    expect(g.admit("e", 60_000)).toBe(false);
  });
  it("normal pace never trips it, and the memory is bounded", () => {
    const g = new NotificationGate({ maxSeen: 5 });
    for (let i = 0; i < 20; i++) expect(g.admit(`n${i}`, i * 20_000)).toBe(true);
    expect(g.ids()).toHaveLength(5);
    expect(g.tripped).toBe(false);
  });
});
