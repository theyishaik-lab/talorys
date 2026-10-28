import type { Database } from "../db/database";
import { newId, now } from "../db/database";
import type { Env } from "../env";
import type { NativePushService } from "./native";
import { type PushKeys, type SendResult, sendPush } from "./webpush";

/** What a device can be told about. Each subscription keeps its own on/off per kind. */
export const PUSH_KINDS = ["approval", "result", "reminder"] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export type PushPrefs = Record<PushKind, boolean>;

export const DEFAULT_PREFS: PushPrefs = { approval: true, result: true, reminder: true };

/** The JSON a service worker receives. Kept small: a push payload has a 4 KB ceiling at most services. */
export interface PushMessage {
  kind: PushKind | "test";
  title: string;
  body: string;
  /** Collapses repeats of the same thing on the device and at the push service. */
  tag: string;
  /** Where a tap opens, as a same-origin path. */
  url: string;
  /** The pending action, when the notification is an approval request. */
  actionId?: string;
  /** Whether the notification may offer Approve/Decline buttons (low-risk actions only). */
  actions?: boolean;
}

export interface PushSubscriptionView {
  id: string;
  label: string;
  prefs: PushPrefs;
  created_at: string;
  last_used_at: string | null;
  failures: number;
}

interface Row {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  prefs: string;
  created_at: string;
  last_used_at: string | null;
  failures: number;
}

const MAX_FAILURES = 8;
const MAX_SUBSCRIPTIONS = 20;
const MAX_BODY = 400;

/** A stored prefs JSON column, every kind on unless explicitly turned off (Web Push and native devices). */
export function parsePrefs(json: string): PushPrefs {
  try {
    const raw = JSON.parse(json) as Partial<PushPrefs>;
    return { approval: raw.approval !== false, result: raw.result !== false, reminder: raw.reminder !== false };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function present(r: Row): PushSubscriptionView {
  return { id: r.id, label: r.label, prefs: parsePrefs(r.prefs), created_at: r.created_at, last_used_at: r.last_used_at, failures: r.failures };
}

/** One line of a notification body: first line of the text, trimmed to a phone-sized length. */
export function excerpt(text: string, max = MAX_BODY): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function pushKeysFromEnv(env: Pick<Env, "VAPID_PUBLIC_KEY" | "VAPID_PRIVATE_KEY" | "VAPID_SUBJECT">): PushKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || "mailto:owner@talorys.local" };
}

/**
 * Device subscriptions and the sends to them. Sends are fire-and-forget through `deliver`
 * (`ctx.waitUntil` in the Durable Object) so a chat turn never waits on a push service.
 */
export class PushService {
  /** The transport; tests replace it with a fake push service. */
  send: typeof sendPush = sendPush;
  /** The native (FCM) channel, when the Worker has a Firebase service account. Same kinds, own devices. */
  native: NativePushService | null = null;

  constructor(
    private readonly db: Database,
    private readonly keys: PushKeys | null,
    private readonly deliver: (work: Promise<unknown>) => void,
  ) {}

  /** Push is configured when the Worker has VAPID keys. */
  get enabled(): boolean {
    return this.keys !== null;
  }

  get publicKey(): string | null {
    return this.keys?.publicKey ?? null;
  }

  list(): PushSubscriptionView[] {
    return this.db.all<Row>(`SELECT * FROM tal_push_subscriptions ORDER BY created_at`).map(present);
  }

  /** Registers a device, or refreshes it when the endpoint is already known (same device re-subscribing). */
  subscribe(input: { endpoint: string; p256dh: string; auth: string; label?: string; prefs?: Partial<PushPrefs> }): PushSubscriptionView {
    const existing = this.db.one<Row>(`SELECT * FROM tal_push_subscriptions WHERE endpoint = ?`, input.endpoint);
    const at = now();
    const prefs: PushPrefs = { ...(existing ? parsePrefs(existing.prefs) : DEFAULT_PREFS), ...(input.prefs ?? {}) };
    const label = (input.label ?? existing?.label ?? "").slice(0, 80);
    if (existing) {
      this.db.run(
        `UPDATE tal_push_subscriptions SET p256dh = ?, auth = ?, label = ?, prefs = ?, failures = 0 WHERE id = ?`,
        input.p256dh, input.auth, label, JSON.stringify(prefs), existing.id,
      );
      return present({ ...existing, p256dh: input.p256dh, auth: input.auth, label, prefs: JSON.stringify(prefs), failures: 0 });
    }
    const row: Row = { id: newId(), endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, label, prefs: JSON.stringify(prefs), created_at: at, last_used_at: null, failures: 0 };
    this.db.run(
      `INSERT INTO tal_push_subscriptions (id, endpoint, p256dh, auth, label, prefs, created_at, last_used_at, failures) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0)`,
      row.id, row.endpoint, row.p256dh, row.auth, row.label, row.prefs, row.created_at,
    );
    // The oldest devices drop off once the list is long: a lost phone never keeps receiving forever.
    this.db.run(
      `DELETE FROM tal_push_subscriptions WHERE id NOT IN (SELECT id FROM tal_push_subscriptions ORDER BY created_at DESC LIMIT ?)`,
      MAX_SUBSCRIPTIONS,
    );
    return present(row);
  }

  get(id: string): PushSubscriptionView | null {
    const row = this.db.one<Row>(`SELECT * FROM tal_push_subscriptions WHERE id = ?`, id);
    return row ? present(row) : null;
  }

  /** The id of the device behind an endpoint, so a browser can find its own row. */
  idForEndpoint(endpoint: string): string | null {
    return this.db.one<{ id: string }>(`SELECT id FROM tal_push_subscriptions WHERE endpoint = ?`, endpoint)?.id ?? null;
  }

  setPrefs(id: string, patch: Partial<PushPrefs>): PushSubscriptionView | null {
    const row = this.db.one<Row>(`SELECT * FROM tal_push_subscriptions WHERE id = ?`, id);
    if (!row) return null;
    const prefs = { ...parsePrefs(row.prefs), ...patch };
    this.db.run(`UPDATE tal_push_subscriptions SET prefs = ? WHERE id = ?`, JSON.stringify(prefs), id);
    return present({ ...row, prefs: JSON.stringify(prefs) });
  }

  unsubscribe(id: string): boolean {
    return this.db.run(`DELETE FROM tal_push_subscriptions WHERE id = ?`, id).changes === 1;
  }

  /** Queues `message` for every device that wants `message.kind`. Returns how many were queued. */
  notify(message: PushMessage): number {
    const native = this.native?.notify(message) ?? 0;
    if (!this.keys) return native;
    const rows = this.db.all<Row>(`SELECT * FROM tal_push_subscriptions`).filter((r) => message.kind === "test" || parsePrefs(r.prefs)[message.kind]);
    if (rows.length === 0) return native;
    this.deliver(this.sendAll(rows, message));
    return rows.length + native;
  }

  /** Sends now and waits for the push services' answers — the Settings "test" button. */
  async sendNow(message: PushMessage, id?: string): Promise<Array<{ id: string; label: string } & SendResult>> {
    if (!this.keys) return [];
    const rows = this.db.all<Row>(`SELECT * FROM tal_push_subscriptions${id ? " WHERE id = ?" : ""}`, ...(id ? [id] : []));
    return await this.sendAll(rows, message);
  }

  private async sendAll(rows: Row[], message: PushMessage): Promise<Array<{ id: string; label: string } & SendResult>> {
    const keys = this.keys;
    if (!keys) return [];
    const payload = JSON.stringify(message);
    const results = await Promise.all(
      rows.map(async (row) => {
        const result = await this.send(keys, { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth }, payload, {
          ttl: message.kind === "approval" ? 1800 : 24 * 3600,
          urgency: message.kind === "approval" ? "high" : "normal",
          topic: message.tag,
        });
        this.record(row, result);
        return { id: row.id, label: row.label, ...result };
      }),
    );
    return results;
  }

  private record(row: Row, result: SendResult): void {
    try {
      if (result.ok) {
        this.db.run(`UPDATE tal_push_subscriptions SET last_used_at = ?, failures = 0 WHERE id = ?`, now(), row.id);
      } else if (result.gone || row.failures + 1 >= MAX_FAILURES) {
        this.db.run(`DELETE FROM tal_push_subscriptions WHERE id = ?`, row.id);
      } else {
        this.db.run(`UPDATE tal_push_subscriptions SET failures = failures + 1 WHERE id = ?`, row.id);
      }
    } catch (error) {
      console.error("push bookkeeping failed", error);
    }
  }
}

/**
 * Whether an approval may be answered from the notification's buttons (no unlock, no card).
 * Only actions that merely add something low-stakes qualify: creating a task, an event, a note.
 * Anything that sends, deletes, pays, shares or connects an app needs the full card in the app.
 */
export function isLowRiskAction(tool: string, targetId: string): boolean {
  if (tool === "connect_service") return false;
  let actionName = tool;
  if (tool === "propose_action") {
    try {
      const target = JSON.parse(targetId) as { action?: unknown };
      if (typeof target.action === "string") actionName = target.action;
    } catch {
      return false;
    }
  }
  const name = actionName.toLowerCase();
  if (/(send|delete|remove|destroy|cancel|pay|purchase|order|transfer|share|publish|post|reply|forward|invite|connect|archive|trash|move|grant|revoke)/.test(name)) return false;
  return /(^|[._])(create|insert|add|new)[_a-z]*(task|event|todo|note|item|reminder|issue|card|page|row|label)/.test(name) || /^(create|add)_(task|note|project|reminder)$/.test(name);
}
