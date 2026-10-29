import { type Database, likePattern } from "./database";

/**
 * Full-text search over every chat message (all threads: main, project-*, updates-*, ordinary
 * chats), so the main chat can recall what was said anywhere.
 *
 * The index is an external-content FTS5 table kept in sync by triggers. It prefers the `trigram`
 * tokenizer, which matches substrings: Hebrew words carry prefixes (ה/ו/ב/ל/ש…) that a word
 * tokenizer would never match. If this SQLite build lacks trigram, the default tokenizer is used;
 * if FTS5 itself fails, search falls back to LIKE. Setup is guarded (not a numbered migration) so
 * a missing feature can never stop the agent from starting.
 */
export const MESSAGE_FTS_TABLE = "tal_messages_fts";

export type MessageSearchMode = "trigram" | "words" | "like";

const modes = new WeakMap<Database, MessageSearchMode>();

function triggers(): string[] {
  return [
    `CREATE TRIGGER IF NOT EXISTS tal_messages_fts_ai AFTER INSERT ON tal_messages BEGIN
      INSERT INTO ${MESSAGE_FTS_TABLE}(rowid, content) VALUES (new.rowid, new.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS tal_messages_fts_ad AFTER DELETE ON tal_messages BEGIN
      INSERT INTO ${MESSAGE_FTS_TABLE}(${MESSAGE_FTS_TABLE}, rowid, content) VALUES ('delete', old.rowid, old.content);
    END`,
    `CREATE TRIGGER IF NOT EXISTS tal_messages_fts_au AFTER UPDATE OF content ON tal_messages BEGIN
      INSERT INTO ${MESSAGE_FTS_TABLE}(${MESSAGE_FTS_TABLE}, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO ${MESSAGE_FTS_TABLE}(rowid, content) VALUES (new.rowid, new.content);
    END`,
  ];
}

function existingMode(db: Database): MessageSearchMode | null {
  const row = db.one<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, MESSAGE_FTS_TABLE);
  if (!row) return null;
  return /trigram/i.test(row.sql) ? "trigram" : "words";
}

/** Creates (once) and backfills the message index. Returns the mode search will use. Never throws. */
export function ensureMessageSearch(db: Database): MessageSearchMode {
  const cached = modes.get(db);
  if (cached) return cached;
  let mode: MessageSearchMode = "like";
  try {
    const existing = existingMode(db);
    if (existing) {
      // Triggers are idempotent; re-assert them in case an earlier setup stopped half way.
      for (const t of triggers()) db.run(t);
      mode = existing;
    } else {
      for (const [candidate, tokenize] of [["trigram", ", tokenize='trigram'"], ["words", ""]] as const) {
        try {
          db.transaction(() => {
            db.run(`CREATE VIRTUAL TABLE ${MESSAGE_FTS_TABLE} USING fts5(content, content='tal_messages', content_rowid='rowid'${tokenize})`);
            for (const t of triggers()) db.run(t);
            db.run(`INSERT INTO ${MESSAGE_FTS_TABLE}(${MESSAGE_FTS_TABLE}) VALUES ('rebuild')`);
          });
          mode = candidate;
          break;
        } catch (error) {
          console.warn(`message search: ${candidate} index unavailable`, error);
        }
      }
    }
  } catch (error) {
    console.warn("message search setup failed; using LIKE", error);
    mode = "like";
  }
  modes.set(db, mode);
  return mode;
}

export interface MessageHit {
  id: string;
  conversation_id: string;
  conversation_title: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

const TERM_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
const STOP = new Set(
  "the and for are was were with that this what when where which who why how you your our have has had from into about just like want need tell show give make get did does can could would should will please".split(" "),
);

/** Search terms from free text: lower-cased words of 2+ characters, stop words removed, at most 8. */
export function searchTerms(q: string): string[] {
  const terms = (q.toLowerCase().match(TERM_RE) ?? []).map((t) => t.replace(/['’-]+$/g, "")).filter((t) => t.length >= 2 && !STOP.has(t));
  return [...new Set(terms)].slice(0, 8);
}

/** The FTS5 MATCH expression for `terms` in `mode`, or null when the index cannot serve them. */
export function messageMatch(terms: string[], mode: MessageSearchMode): string | null {
  if (mode === "like") return null;
  const usable = mode === "trigram" ? terms.filter((t) => [...t].length >= 3) : terms;
  if (usable.length === 0) return null;
  const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;
  return usable.map((t) => (mode === "trigram" ? quote(t) : `${quote(t)}*`)).join(" OR ");
}

export interface MessageSearchOptions {
  limit?: number;
  /** Only this thread. */
  conversationId?: string;
  /** Leave this thread out (the chat asking already has its own history in view). */
  excludeConversationId?: string;
  /** Only messages created at or after this ISO time. */
  since?: string;
}

/**
 * Messages matching `q` across threads, best first (BM25), topped up with substring (LIKE) matches
 * for terms the index cannot serve (two-letter words in trigram mode), newest first.
 */
export function searchMessages(db: Database, q: string, opts: MessageSearchOptions = {}): MessageHit[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 10, 50));
  const terms = searchTerms(q);
  if (terms.length === 0) return [];
  const mode = ensureMessageSearch(db);
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.conversationId) {
    where.push(`m.conversation_id = ?`);
    params.push(opts.conversationId);
  }
  if (opts.excludeConversationId) {
    where.push(`m.conversation_id <> ?`);
    params.push(opts.excludeConversationId);
  }
  if (opts.since) {
    where.push(`m.created_at >= ?`);
    params.push(opts.since);
  }
  const extra = where.length ? ` AND ${where.join(" AND ")}` : "";
  const select = `SELECT m.id, m.conversation_id, c.title AS conversation_title, m.role, m.content, m.created_at
    FROM tal_messages m JOIN tal_conversations c ON c.id = m.conversation_id`;
  const hits = new Map<string, MessageHit>();
  const match = messageMatch(terms, mode);
  if (match) {
    try {
      for (const h of db.all<MessageHit>(
        `${select} JOIN ${MESSAGE_FTS_TABLE} f ON f.rowid = m.rowid
         WHERE ${MESSAGE_FTS_TABLE} MATCH ?${extra} ORDER BY bm25(${MESSAGE_FTS_TABLE}) LIMIT ?`,
        match, ...params, limit,
      )) hits.set(h.id, h);
    } catch (error) {
      console.warn("message FTS query failed; using LIKE", error);
    }
  }
  if (hits.size < limit) {
    // Terms the index skipped (or every term, without an index): substring match on any of them.
    const likeTerms = match && mode === "trigram" ? terms.filter((t) => [...t].length < 3) : match ? [] : terms;
    if (likeTerms.length) {
      const any = likeTerms.map(() => `m.content LIKE ? ESCAPE '\\'`).join(" OR ");
      for (const h of db.all<MessageHit>(
        `${select} WHERE (${any})${extra} ORDER BY m.created_at DESC LIMIT ?`,
        ...likeTerms.map(likePattern), ...params, limit,
      )) {
        if (hits.size >= limit) break;
        if (!hits.has(h.id)) hits.set(h.id, h);
      }
    }
  }
  return [...hits.values()];
}

/** A short excerpt of `content` around the first matching term. */
export function snippet(content: string, terms: string[], max = 280): string {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  const start = Math.max(0, at < 0 ? 0 : at - Math.floor(max / 3));
  const cut = text.slice(start, start + max);
  return `${start > 0 ? "…" : ""}${cut}${start + max < text.length ? "…" : ""}`;
}
