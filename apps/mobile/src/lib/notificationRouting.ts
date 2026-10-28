/**
 * Where a notification tap lands, and when it is safe to go there. Pure (no native imports) so it is
 * unit-tested in tests/notification-routing.test.ts; the hook in useNotificationRouting.ts wires it
 * to expo-notifications and expo-router.
 *
 * Why this exists (0.3.1): a push carrying a thread id, tapped while the app was closed, made the
 * app blink forever. The tap was routed at mount, before the session was read. Every app screen sits
 * behind a Stack.Protected guard that is still false then, so the app's root Stack renders nothing and
 * the only mounted navigator is expo-router's internal outer stack (`__root`, `+not-found`,
 * `_sitemap`). router.push("/chat/<id>") diverged at that outer stack and became
 * PUSH `__root` { screen: "chat/[id]" } — a SECOND copy of the whole root layout. That copy started
 * signed-out-and-not-ready again, getLastNotificationResponseAsync() handed it the same response,
 * it pushed another `__root`, and so on. Hence: route only when the app navigator is mounted and the
 * session is ready and signed in, handle each notification once, navigate instead of stacking, and
 * stop if taps ever turn into a burst of navigations.
 */

export type NotificationTarget = { kind: "chat" } | { kind: "thread"; id: string } | { kind: "project"; id: string };

export const MAIN_THREAD = "main";
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * The thread a notification is about. Newest key first:
 * - `thread` (agent since 0.3.1's server change; older apps ignore it, which keeps 0.2.3 from looping),
 * - `conversation_id` (agent before that),
 * - the url: `/chat/<id>` (old) or `/chat?thread=<id>` (new).
 */
export function threadOf(data: Record<string, unknown> | null | undefined): string | undefined {
  if (!data) return undefined;
  const url = str(data.url) ?? "";
  const candidate = str(data.thread) ?? str(data.conversation_id) ?? url.match(/\/chat\/([A-Za-z0-9_-]+)/)?.[1] ?? url.match(/[?&]thread=([A-Za-z0-9_-]+)/)?.[1];
  return candidate && ID_RE.test(candidate) ? candidate : undefined;
}

/** Where a notification tap should land: the chat (and action) named in the payload. */
export function targetOf(data: Record<string, unknown> | undefined): { conversationId?: string; actionId?: string } {
  return { conversationId: threadOf(data), actionId: data ? str(data.action_id) : undefined };
}

/** The screen for a thread id: the Chat tab for `main`, a project's screen, or a pushed thread. */
export function notificationTarget(data: Record<string, unknown> | null | undefined): NotificationTarget | null {
  const id = threadOf(data);
  if (!id) return null;
  if (id === MAIN_THREAD) return { kind: "chat" };
  if (id.startsWith("project-")) {
    const projectId = id.slice("project-".length);
    return ID_RE.test(projectId) ? { kind: "project", id: projectId } : null;
  }
  return { kind: "thread", id };
}

/** The expo-router href for a target (always used with router.navigate, never push). */
export function hrefOf(target: NotificationTarget): string | { pathname: "/chat/[id]" | "/projects/[id]"; params: { id: string } } {
  if (target.kind === "chat") return "/chat";
  if (target.kind === "project") return { pathname: "/projects/[id]", params: { id: target.id } };
  return { pathname: "/chat/[id]", params: { id: target.id } };
}

interface NavStateLike {
  index?: number;
  routes?: readonly { name?: string; state?: unknown }[];
}

/**
 * Whether the app's own root Stack is mounted inside expo-router's internal outer stack. Until it
 * is, any navigation targets that outer stack and duplicates the whole app (the 0.2.3 loop).
 */
export function appNavigatorMounted(rootState: NavStateLike | null | undefined): boolean {
  const routes = rootState?.routes;
  if (!routes || routes.length === 0) return false;
  const focused = routes[rootState?.index ?? routes.length - 1];
  return Boolean(focused && focused.name === "__root" && focused.state);
}

/** Every condition for routing a tap at all. */
export function canRoute(auth: { ready: boolean; authenticated: boolean }, rootState: NavStateLike | null | undefined): boolean {
  return auth.ready && auth.authenticated && appNavigatorMounted(rootState);
}

/**
 * Remembers which notifications were handled (by request identifier: the listener and
 * getLastNotificationResponse report the same tap, and getLast keeps returning it) and trips a breaker
 * when navigations come in a burst, so a future bug of the same shape can't spin forever.
 */
export class NotificationGate {
  private readonly seen: string[] = [];
  private readonly recent: number[] = [];
  tripped = false;

  constructor(
    private readonly opts: { maxSeen?: number; burst?: number; windowMs?: number } = {},
  ) {}

  /** Ids handled in an earlier run of the app (persisted), so a restored activity doesn't reopen them. */
  preload(ids: readonly string[]): void {
    for (const id of ids) if (!this.seen.includes(id)) this.seen.push(id);
    this.trim();
  }

  has(id: string): boolean {
    return this.seen.includes(id);
  }

  /** Records the tap; false when it was already handled or the breaker tripped. */
  admit(id: string, now: number): boolean {
    if (this.tripped || !id || this.has(id)) return false;
    const windowMs = this.opts.windowMs ?? 10_000;
    const burst = this.opts.burst ?? 3;
    while (this.recent.length && now - (this.recent[0] ?? 0) > windowMs) this.recent.shift();
    if (this.recent.length >= burst) {
      this.tripped = true;
      return false;
    }
    this.recent.push(now);
    this.seen.push(id);
    this.trim();
    return true;
  }

  ids(): string[] {
    return [...this.seen];
  }

  private trim(): void {
    const max = this.opts.maxSeen ?? 50;
    while (this.seen.length > max) this.seen.shift();
  }
}
