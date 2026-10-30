import { z } from "zod";
import type { Database } from "../db/database";
import { now } from "../db/database";

/**
 * Backup of the Talorys Keyboard's learned dictionary (words and bigrams it picked up while typing).
 * One JSON document per owner. The merge mirrors the keyboard's own DictionaryMerge (UserDictionary.kt):
 * union by key (w+lang, a+b+lang), max count, max lastUsed, and a deleted entry wins when its
 * lastUsed is >= the other side's.
 */

export const KEYBOARD_MAX_WORDS = 200_000;
export const KEYBOARD_MAX_BIGRAMS = 500_000;
/** Words the keyboard learned from what was on screen (only sent when the owner turned that backup on). */
export const KEYBOARD_MAX_SCREEN_WORDS = 20_000;
/** Largest PUT body accepted (bytes). */
export const KEYBOARD_MAX_BODY_BYTES = 5 * 1024 * 1024;

const lang = z.enum(["he", "en"]);
const token = z.string().max(64);
const count = z.number().int().min(0);
const time = z.number().finite();

export const learnedWordSchema = z.object({ w: token, lang, count, lastUsed: time, deleted: z.boolean().optional() });
export const learnedBigramSchema = z.object({ a: token, b: token, lang, count, lastUsed: time, deleted: z.boolean().optional() });

export const keyboardDictionarySchema = z.object({
  schema: z.literal(1),
  updatedAt: time,
  words: z.array(learnedWordSchema),
  bigrams: z.array(learnedBigramSchema),
  /**
   * Keyboard 1.4.1+: words learned from text on screen, kept apart from typed words. Optional: the
   * keyboard sends it only when the owner turned on "include screen words in the backup"; a backup
   * without it keeps whatever screen words were stored before (count = sightings).
   */
  screenWords: z.array(learnedWordSchema).max(KEYBOARD_MAX_SCREEN_WORDS).optional(),
});

export type LearnedWord = z.infer<typeof learnedWordSchema>;
export type LearnedBigram = z.infer<typeof learnedBigramSchema>;
export type KeyboardDictionary = z.infer<typeof keyboardDictionarySchema>;

function mergeDeleted(x: { deleted?: boolean; lastUsed: number }, y: { deleted?: boolean; lastUsed: number }): boolean {
  if (x.deleted && y.deleted) return true;
  if (x.deleted) return x.lastUsed >= y.lastUsed;
  if (y.deleted) return y.lastUsed >= x.lastUsed;
  return false;
}

export function mergeWord(x: LearnedWord, y: LearnedWord): LearnedWord {
  const out: LearnedWord = { w: x.w, lang: x.lang, count: Math.max(x.count, y.count), lastUsed: Math.max(x.lastUsed, y.lastUsed) };
  if (mergeDeleted(x, y)) out.deleted = true;
  return out;
}

export function mergeBigram(x: LearnedBigram, y: LearnedBigram): LearnedBigram {
  const out: LearnedBigram = { a: x.a, b: x.b, lang: x.lang, count: Math.max(x.count, y.count), lastUsed: Math.max(x.lastUsed, y.lastUsed) };
  if (mergeDeleted(x, y)) out.deleted = true;
  return out;
}

const wordKey = (w: LearnedWord) => `${w.lang}\u0001${w.w}`;
const bigramKey = (b: LearnedBigram) => `${b.lang}\u0001${b.a}\u0001${b.b}`;

function normalize<T extends { deleted?: boolean }>(e: T): T {
  if (e.deleted) return e;
  const { deleted: _drop, ...rest } = e;
  return rest as T;
}

/** Merges `incoming` into `stored` (either may hold duplicate keys; they collapse too). */
export function mergeDictionaries(stored: KeyboardDictionary | null, incoming: KeyboardDictionary, nowMs = Date.now()): KeyboardDictionary {
  const words = new Map<string, LearnedWord>();
  for (const w of [...(stored?.words ?? []), ...incoming.words]) {
    const k = wordKey(w);
    const prev = words.get(k);
    words.set(k, prev ? mergeWord(prev, w) : normalize(w));
  }
  const bigrams = new Map<string, LearnedBigram>();
  for (const b of [...(stored?.bigrams ?? []), ...incoming.bigrams]) {
    const k = bigramKey(b);
    const prev = bigrams.get(k);
    bigrams.set(k, prev ? mergeBigram(prev, b) : normalize(b));
  }
  const updatedAt = Math.max(nowMs, incoming.updatedAt, stored?.updatedAt ?? 0);
  const out: KeyboardDictionary = { schema: 1, updatedAt, words: [...words.values()], bigrams: [...bigrams.values()] };
  if (stored?.screenWords || incoming.screenWords) {
    const screen = new Map<string, LearnedWord>();
    for (const w of [...(stored?.screenWords ?? []), ...(incoming.screenWords ?? [])]) {
      const k = wordKey(w);
      const prev = screen.get(k);
      screen.set(k, prev ? mergeWord(prev, w) : normalize(w));
    }
    out.screenWords = [...screen.values()];
  }
  return out;
}

/** Rows hold at most this many UTF-16 units (<= 1.5 MB of UTF-8), under the 2 MB SQLite value cap. */
const CHUNK_CHARS = 500_000;

export class KeyboardDictionaryStore {
  constructor(private readonly db: Database) {}

  /** The stored JSON text, or null when nothing was ever backed up. */
  readRaw(): string | null {
    const rows = this.db.all<{ data: string }>(`SELECT data FROM tal_keyboard_dictionary ORDER BY seq`);
    return rows.length ? rows.map((r) => r.data).join("") : null;
  }

  read(): KeyboardDictionary | null {
    const raw = this.readRaw();
    if (raw === null) return null;
    try {
      const parsed = keyboardDictionarySchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /** Replaces the stored document atomically and returns the JSON written. */
  write(dict: KeyboardDictionary): string {
    const json = JSON.stringify(dict);
    const at = now();
    this.db.transaction(() => {
      this.db.run(`DELETE FROM tal_keyboard_dictionary`);
      for (let i = 0, seq = 0; i < json.length; seq++) {
        let end = Math.min(i + CHUNK_CHARS, json.length);
        // Never split a surrogate pair (an emoji) across rows: SQLite stores each row as UTF-8.
        const last = json.charCodeAt(end - 1);
        if (end < json.length && last >= 0xd800 && last <= 0xdbff) end--;
        this.db.run(`INSERT INTO tal_keyboard_dictionary (seq, data, updated_at) VALUES (?, ?, ?)`, seq, json.slice(i, end), at);
        i = end;
      }
    });
    return json;
  }
}
