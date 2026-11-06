export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/**
 * Thin, synchronous wrapper around Durable Object SQLite storage.
 * All queries use bound parameters; never interpolate values into SQL.
 */
export class Database {
  constructor(private readonly storage: DurableObjectStorage) {}

  all<T = Row>(query: string, ...params: unknown[]): T[] {
    return this.storage.sql.exec(query, ...params.map(normalize)).toArray() as T[];
  }

  one<T = Row>(query: string, ...params: unknown[]): T | null {
    const rows = this.all<T>(query, ...params);
    return rows[0] ?? null;
  }

  run(query: string, ...params: unknown[]): { changes: number } {
    const cursor = this.storage.sql.exec(query, ...params.map(normalize));
    // Drain the cursor so the statement fully executes.
    cursor.toArray();
    return { changes: cursor.rowsWritten };
  }

  /** Runs `fn` atomically. Throwing rolls the transaction back. */
  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
}

function normalize(value: unknown): SqlValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  return JSON.stringify(value);
}

export const now = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();

/** Escapes a user query for SQLite LIKE with ESCAPE '\'. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

// Query builders live with the Hebrew-aware normalization (schema 16); re-exported for callers.
export { ftsQuery, legacyFtsQuery } from "./search-text";
