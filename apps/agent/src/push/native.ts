import type { Database } from "../db/database";
import { newId, now } from "../db/database";
import { type FcmCredentials, type FcmSendResult, sendFcm } from "./fcm";
import { DEFAULT_PREFS, type PushMessage, type PushPrefs } from "./service";

/**
 * Native devices (the Android app) registered for Firebase Cloud Messaging. Same kinds and
 * preferences as Web Push subscriptions; one row per device token.
 */
export interface PushDeviceView {
  id: string;
  label: string;
  platform: "android" | "ios";
  prefs: PushPrefs;
  created_at: string;
  last_used_at: string | null;
  failures: number;
}

interface Row {
  id: string;
  token: string;
  platform: string;
  label: string;
  prefs: string;
  created_at: string;
  last_used_at: string | null;
  failures: number;
}

const MAX_FAILURES = 8;
const MAX_DEVICES = 20;

function parsePrefs(json: string): PushPrefs {
  try {
    const raw = JSON.parse(json) as Partial<PushPrefs>;
    return { approval: raw.approval !== false, result: raw.result !== false, reminder: raw.reminder !== false };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function present(r: Row): PushDeviceView {
  return { id: r.id, label: r.label, platform: r.platform === "ios" ? "ios" : "android", prefs: parsePrefs(r.prefs), created_at: r.created_at, last_used_at: r.last_used_at, failures: r.failures };
}

export class NativePushService {
  /** The transport; tests replace it. */
  send: typeof sendFcm = sendFcm;

  constructor(
    private readonly db: Database,
    private readonly creds: FcmCredentials | null,
    /** Absolute origin the notification's deep link points at (the web app / Pages URL). */
    private readonly deepLinkBase: string,
    private readonly deliver: (work: Promise<unknown>) => void,
  ) {}

  /** Native push is configured when the Worker has a Firebase service account. */
  get enabled(): boolean {
    return this.creds !== null;
  }

  list(): PushDeviceView[] {
    return this.db.all<Row>(`SELECT * FROM tal_push_devices ORDER BY created_at`).map(present);
  }

  get(id: string): PushDeviceView | null {
    const row = this.db.one<Row>(`SELECT * FROM tal_push_devices WHERE id = ?`, id);
    return row ? present(row) : null;
  }

  /** Registers a device token, or refreshes the row that already has it (same phone, new app start). */
  register(input: { token: string; platform: "android" | "ios"; label?: string; prefs?: Partial<PushPrefs> }): PushDeviceView {
    const existing = this.db.one<Row>(`SELECT * FROM tal_push_devices WHERE token = ?`, input.token);
    const prefs: PushPrefs = { ...(existing ? parsePrefs(existing.prefs) : DEFAULT_PREFS), ...(input.prefs ?? {}) };
    const label = (input.label ?? existing?.label ?? "").slice(0, 80);
    if (existing) {
      this.db.run(`UPDATE tal_push_devices SET platform = ?, label = ?, prefs = ?, failures = 0 WHERE id = ?`, input.platform, label, JSON.stringify(prefs), existing.id);
      return present({ ...existing, platform: input.platform, label, prefs: JSON.stringify(prefs), failures: 0 });
    }
    const row: Row = { id: newId(), token: input.token, platform: input.platform, label, prefs: JSON.stringify(prefs), created_at: now(), last_used_at: null, failures: 0 };
    this.db.run(
      `INSERT INTO tal_push_devices (id, token, platform, label, prefs, created_at, last_used_at, failures) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
      row.id, row.token, row.platform, row.label, row.prefs, row.created_at,
    );
    this.db.run(`DELETE FROM tal_push_devices WHERE id NOT IN (SELECT id FROM tal_push_devices ORDER BY created_at DESC LIMIT ?)`, MAX_DEVICES);
    return present(row);
  }

  setPrefs(id: string, patch: Partial<PushPrefs>): PushDeviceView | null {
    const row = this.db.one<Row>(`SELECT * FROM tal_push_devices WHERE id = ?`, id);
    if (!row) return null;
    const prefs = { ...parsePrefs(row.prefs), ...patch };
    this.db.run(`UPDATE tal_push_devices SET prefs = ? WHERE id = ?`, JSON.stringify(prefs), id);
    return present({ ...row, prefs: JSON.stringify(prefs) });
  }

  unregister(id: string): boolean {
    return this.db.run(`DELETE FROM tal_push_devices WHERE id = ?`, id).changes === 1;
  }

  /** Queues `message` for every device that wants `message.kind`. Returns how many were queued. */
  notify(message: PushMessage): number {
    if (!this.creds) return 0;
    const rows = this.db.all<Row>(`SELECT * FROM tal_push_devices`).filter((r) => message.kind === "test" || parsePrefs(r.prefs)[message.kind]);
    if (rows.length === 0) return 0;
    this.deliver(this.sendAll(rows, message));
    return rows.length;
  }

  /** Sends now and waits for FCM's answers — the app's "send test" button. */
  async sendNow(message: PushMessage, id?: string): Promise<Array<{ id: string; label: string } & FcmSendResult>> {
    if (!this.creds) return [];
    const rows = this.db.all<Row>(`SELECT * FROM tal_push_devices${id ? " WHERE id = ?" : ""}`, ...(id ? [id] : []));
    return await this.sendAll(rows, message);
  }

  private async sendAll(rows: Row[], message: PushMessage): Promise<Array<{ id: string; label: string } & FcmSendResult>> {
    const creds = this.creds;
    if (!creds) return [];
    return await Promise.all(
      rows.map(async (row) => {
        const result = await this.send(creds, row.token, message, this.deepLinkBase);
        this.record(row, result);
        return { id: row.id, label: row.label, ...result };
      }),
    );
  }

  private record(row: Row, result: FcmSendResult): void {
    try {
      if (result.ok) this.db.run(`UPDATE tal_push_devices SET last_used_at = ?, failures = 0 WHERE id = ?`, now(), row.id);
      else if (result.gone || row.failures + 1 >= MAX_FAILURES) this.db.run(`DELETE FROM tal_push_devices WHERE id = ?`, row.id);
      else this.db.run(`UPDATE tal_push_devices SET failures = failures + 1 WHERE id = ?`, row.id);
    } catch (error) {
      console.error("native push bookkeeping failed", error);
    }
  }
}
