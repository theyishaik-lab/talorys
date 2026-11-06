import type { Database } from "./database";
import { indexText } from "./search-text";

/**
 * Hebrew-aware full-text indexes for memories and notes (schema 16, see search-text.ts).
 *
 * The indexed text is computed in JS (Durable Object SQLite has no custom tokenizers or SQL
 * functions), so the tables are plain FTS5 tables with their own copy of the normalized text,
 * keyed by the source row's rowid. Triggers on the source tables only mark rows dirty
 * (`tal_search_dirty`); `syncSearchIndex()` re-indexes dirty rows and runs before every search,
 * so any write path (repositories, backup import, raw SQL) is picked up without knowing about it.
 *
 * The pre-16 `tal_memories_fts` / `tal_notes_fts` indexes stay in place as a fallback.
 */
export const MEMORY_SEARCH_TABLE = "tal_memories_search";
export const NOTE_SEARCH_TABLE = "tal_notes_search";

/** BM25 column weights: exact (normalized) words count double a prefix-stripped stem match. */
export const MEMORY_SEARCH_WEIGHTS = "1.0, 0.5";
/** title, body, stems. */
export const NOTE_SEARCH_WEIGHTS = "2.0, 1.0, 0.5";

const TOKENIZE = `tokenize='unicode61 remove_diacritics 2'`;

/** Statements of migration 16: the indexes, the dirty-row queue and its triggers, and a full reindex. */
export function searchIndexMigration(): string[] {
  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${MEMORY_SEARCH_TABLE} USING fts5(body, stems, ${TOKENIZE})`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${NOTE_SEARCH_TABLE} USING fts5(title, body, stems, ${TOKENIZE})`,
    `CREATE TABLE IF NOT EXISTS tal_search_dirty (
      kind TEXT NOT NULL,
      row INTEGER NOT NULL,
      PRIMARY KEY (kind, row)
    )`,
    `CREATE TRIGGER IF NOT EXISTS tal_memories_search_ai AFTER INSERT ON tal_memories BEGIN
      INSERT OR IGNORE INTO tal_search_dirty (kind, row) VALUES ('memory', new.rowid);
    END`,
    `CREATE TRIGGER IF NOT EXISTS tal_memories_search_ad AFTER DELETE ON tal_memories BEGIN
      INSERT OR IGNORE INTO tal_search_dirty (kind, row) VALUES ('memory', old.rowid);
    END`,
    `CREATE TRIGGER IF NOT EXISTS tal_memories_search_au AFTER UPDATE OF content ON tal_memories BEGIN
      INSERT OR IGNORE INTO tal_search_dirty (kind, row) VALUES ('memory', old.rowid);
      INSERT OR IGNORE INTO tal_search_dirty (kind, row) VALUES ('memory', new.rowid);
    END`,
    `CREATE TRIGGER IF NOT EXISTS tal_notes_search_ai AFTER INSERT ON tal_notes BEGIN
      INSERT OR IGNORE INTO tal_search_dirty (kind, row) VALUES ('note', new.rowid);
    END`,
    `CREATE TRIGGER IF NOT EXISTS tal_notes_search_ad AFTER DELETE ON tal_notes BEGIN
      INSERT OR IGNORE INTO tal_search_dirty (kind, row) VALUES ('note', old.rowid);
    END`,
    `CREATE TRIGGER IF NOT EXISTS tal_notes_search_au AFTER UPDATE OF title, content ON tal_notes BEGIN
      INSERT OR IGNORE INTO tal_search_dirty (kind, row) VALUES ('note', old.rowid);
      INSERT OR IGNORE INTO tal_search_dirty (kind, row) VALUES ('note', new.rowid);
    END`,
    // Full reindex: every existing row is queued; the first sync (right after migrating) builds it.
    `INSERT OR IGNORE INTO tal_search_dirty (kind, row) SELECT 'memory', rowid FROM tal_memories`,
    `INSERT OR IGNORE INTO tal_search_dirty (kind, row) SELECT 'note', rowid FROM tal_notes`,
  ];
}

const BATCH = 200;

/**
 * Re-indexes queued rows. Idempotent (each row is deleted from the index before it is re-added,
 * and leaves the queue only after), so an interrupted sync just resumes. Returns rows processed.
 * Throws if the schema-16 tables are missing; callers fall back to the legacy index.
 */
export function syncSearchIndex(db: Database): number {
  let processed = 0;
  for (;;) {
    const batch = db.all<{ kind: string; row: number }>(`SELECT kind, row FROM tal_search_dirty LIMIT ?`, BATCH);
    if (batch.length === 0) return processed;
    for (const { kind, row } of batch) {
      if (kind === "memory") {
        db.run(`DELETE FROM ${MEMORY_SEARCH_TABLE} WHERE rowid = ?`, row);
        const m = db.one<{ content: string }>(`SELECT content FROM tal_memories WHERE rowid = ?`, row);
        if (m) {
          const t = indexText(m.content);
          db.run(`INSERT INTO ${MEMORY_SEARCH_TABLE} (rowid, body, stems) VALUES (?, ?, ?)`, row, t.body, t.stems);
        }
      } else if (kind === "note") {
        db.run(`DELETE FROM ${NOTE_SEARCH_TABLE} WHERE rowid = ?`, row);
        const n = db.one<{ title: string; content: string }>(`SELECT title, content FROM tal_notes WHERE rowid = ?`, row);
        if (n) {
          const title = indexText(n.title);
          const body = indexText(n.content);
          db.run(
            `INSERT INTO ${NOTE_SEARCH_TABLE} (rowid, title, body, stems) VALUES (?, ?, ?, ?)`,
            row, title.body, body.body, `${title.stems} ${body.stems}`.trim(),
          );
        }
      }
      db.run(`DELETE FROM tal_search_dirty WHERE kind = ? AND row = ?`, kind, row);
      processed++;
    }
  }
}
