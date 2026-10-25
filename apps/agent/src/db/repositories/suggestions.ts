import type { Suggestion, SuggestionKind, SuggestionStatus } from "@talorys/shared";
import { type Database, newId, now } from "../database";

/** How long a surfaced suggestion stays relevant before it auto-expires. */
export const SUGGESTION_TTL_MS = 36 * 3600_000;

interface StoredSuggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  body: string;
  signal_hash: string;
  proposed_tool: string | null;
  proposed_input: string | null;
  status: SuggestionStatus;
  score: number;
  created_at: string;
  expires_at: string;
}

function present(row: StoredSuggestion): Suggestion {
  const expired = (row.status === "new" || row.status === "seen") && row.expires_at <= now();
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    status: expired ? "expired" : row.status,
    score: row.score,
    created_at: row.created_at,
    expires_at: row.expires_at,
    proposed_tool: row.proposed_tool,
    proposed_input: row.proposed_input,
  };
}

/** Proactive suggestions. The engine creates them; the owner lists and dismisses them. */
export class SuggestionRepository {
  constructor(private readonly db: Database) {}

  /**
   * Create a suggestion unless one with the same `signal_hash` is already active
   * (not dismissed/accepted/expired). Returns the new row, or null when deduped.
   */
  create(input: {
    kind: SuggestionKind;
    title: string;
    body: string;
    signalHash: string;
    score?: number;
    ttlMs?: number;
    proposedTool?: string | null;
    proposedInput?: string | null;
  }): Suggestion | null {
    const active = this.db.one<{ id: string }>(
      `SELECT id FROM tal_suggestions
       WHERE signal_hash = ? AND status IN ('new','seen') AND expires_at > ?
       LIMIT 1`,
      input.signalHash,
      now(),
    );
    if (active) return null;

    const createdAt = now();
    const expiresAt = new Date(Date.now() + (input.ttlMs ?? SUGGESTION_TTL_MS)).toISOString();
    const row: StoredSuggestion = {
      id: newId(),
      kind: input.kind,
      title: input.title,
      body: input.body,
      signal_hash: input.signalHash,
      proposed_tool: input.proposedTool ?? null,
      proposed_input: input.proposedInput ?? null,
      status: "new",
      score: input.score ?? 0,
      created_at: createdAt,
      expires_at: expiresAt,
    };
    this.db.run(
      `INSERT INTO tal_suggestions (id, kind, title, body, signal_hash, proposed_tool, proposed_input, status, score, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.kind,
      row.title,
      row.body,
      row.signal_hash,
      row.proposed_tool,
      row.proposed_input,
      row.status,
      row.score,
      row.created_at,
      row.expires_at,
    );
    return present(row);
  }

  list(options: { status?: SuggestionStatus; limit?: number } = {}): Suggestion[] {
    const limit = options.limit ?? 25;
    const rows = options.status
      ? this.db.all<StoredSuggestion>(
          `SELECT * FROM tal_suggestions WHERE status = ? ORDER BY score DESC, created_at DESC LIMIT ?`,
          options.status,
          limit,
        )
      : this.db.all<StoredSuggestion>(
          `SELECT * FROM tal_suggestions WHERE status IN ('new','seen') ORDER BY score DESC, created_at DESC LIMIT ?`,
          limit,
        );
    return rows.map(present);
  }

  get(id: string): Suggestion | null {
    const row = this.db.one<StoredSuggestion>(`SELECT * FROM tal_suggestions WHERE id = ?`, id);
    return row ? present(row) : null;
  }

  setStatus(id: string, status: SuggestionStatus): Suggestion | null {
    this.db.run(`UPDATE tal_suggestions SET status = ? WHERE id = ?`, status, id);
    return this.get(id);
  }

  /** Mark all currently-new suggestions as seen (e.g. when the owner opens the panel). */
  markSeen(): void {
    this.db.run(`UPDATE tal_suggestions SET status = 'seen' WHERE status = 'new'`);
  }

  /** Flip stale new/seen rows to expired. Cheap to call at the start of a scan. */
  expireStale(): void {
    this.db.run(`UPDATE tal_suggestions SET status = 'expired' WHERE status IN ('new','seen') AND expires_at <= ?`, now());
  }

  unseenCount(): number {
    return this.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tal_suggestions WHERE status = 'new' AND expires_at > ?`, now())?.n ?? 0;
  }
}
