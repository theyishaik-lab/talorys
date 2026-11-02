import { type Memory, PINNED_MEMORY_LIMITS } from "@talorys/shared";
import { estimateTokens } from "../ai/provider";
import { ValidationError } from "../api/errors";
import type { MemoryRepository } from "../db/repositories/memories";

/**
 * Core memory (stage 1 of the Alfred-inspired memory, docs/memory-dreaming.md):
 *  - pinned memories: a small owner-chosen set shown to the model in every chat, regardless of search;
 *  - the topic map: a short keyword overview of the rest, so the model knows what search_memories can find.
 * Both are cheap (no AI) and fit inside the existing memory token budget (agent/memory.ts).
 */

/** Pinned memories as the prompt shows them, capped to the pinned limits (oldest pin first). */
export function pinnedForPrompt(repo: MemoryRepository, limits = PINNED_MEMORY_LIMITS): Memory[] {
  const out: Memory[] = [];
  let chars = 0;
  for (const m of repo.listPinned()) {
    if (out.length >= limits.maxItems) break;
    if (chars + m.content.length > limits.maxChars) continue;
    chars += m.content.length;
    out.push(m);
  }
  return out;
}

/** Throws when pinning `memory` would exceed the pinned limits. */
export function assertCanPin(repo: MemoryRepository, memory: Pick<Memory, "id" | "content" | "status">, limits = PINNED_MEMORY_LIMITS): void {
  if (memory.status === "historical") throw new ValidationError("A past fact can't be pinned. Restore it first.");
  const pinned = repo.listPinned().filter((m) => m.id !== memory.id);
  if (pinned.length + 1 > limits.maxItems) {
    throw new ValidationError(`Core memory is full (${limits.maxItems} items). Unpin something first.`);
  }
  const chars = pinned.reduce((n, m) => n + m.content.length, 0) + memory.content.length;
  if (chars > limits.maxChars) {
    throw new ValidationError(`Core memory is limited to ${limits.maxChars} characters. Unpin or shorten something first.`);
  }
}

/** Pins (true) or unpins a memory; enforces the limits on pin. Owner actions only. */
export function setPinned(repo: MemoryRepository, id: string, pinned: boolean): Memory {
  const memory = repo.require(id);
  if (pinned && !memory.pinned) assertCanPin(repo, memory);
  return repo.setPinned(id, pinned);
}

export function pinnedUsage(repo: MemoryRepository) {
  const pinned = repo.listPinned();
  return { items: pinned.length, chars: pinned.reduce((n, m) => n + m.content.length, 0), ...PINNED_MEMORY_LIMITS };
}

// ---------- Topic map ----------

const STOPWORDS = new Set(
  (
    "the a an and or but of to in on at for with from by as is are was were be been being it its this that these those " +
    "owner owners user users has have had his her their they them he she i me my mine you your we our us not no yes " +
    "likes like prefers prefer wants want uses use usually always never often also very more most some any all about " +
    "into over under than then there here when where which who whom what why how does did done will would can could " +
    "should may might just only each other same such own new old one two lives live works work called named " +
    "של את על עם זה זו הוא היא הם הן אני אתה את אנחנו לא כן גם או אבל כי אם יש אין מה מי איך למה כל רק עוד מאוד"
  ).split(/\s+/),
);

/** Categories in a stable order for the map. */
const CATEGORY_ORDER = ["person", "project", "preference", "goal", "habit", "fact", "other"];

const MAX_TERMS_PER_CATEGORY = 8;
export const TOPIC_MAP_MAX_CHARS = 600;

/**
 * A short overview of current non-pinned memories: per category, the count and the most frequent
 * keywords (capitalized words weigh more, as names and places usually are). Deterministic, no AI.
 */
export function buildTopicMap(memories: Pick<Memory, "content" | "category" | "pinned" | "status">[], maxChars = TOPIC_MAP_MAX_CHARS): string | null {
  const byCategory = new Map<string, { n: number; terms: Map<string, number> }>();
  for (const m of memories) {
    if (m.pinned || m.status === "historical") continue;
    const entry = byCategory.get(m.category) ?? { n: 0, terms: new Map<string, number>() };
    entry.n++;
    const seen = new Set<string>();
    for (const raw of m.content.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []) {
      const word = raw.replace(/['’]s$/i, "");
      const key = word.toLowerCase();
      if (key.length < 3 || STOPWORDS.has(key) || /^\d+$/.test(key) || seen.has(key)) continue;
      seen.add(key);
      const weight = /^\p{Lu}/u.test(word) ? 2 : 1;
      entry.terms.set(key, (entry.terms.get(key) ?? 0) + weight);
    }
    byCategory.set(m.category, entry);
  }
  if (byCategory.size === 0) return null;
  const lines: string[] = [];
  const cats = [...byCategory.keys()].sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a);
    const ib = CATEGORY_ORDER.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
  for (const cat of cats) {
    const { n, terms } = byCategory.get(cat)!;
    // In a bigger category a word seen once is noise; the category's own name says nothing.
    const top = [...terms.entries()]
      .filter(([t, count]) => t !== cat && (n <= 3 || count >= 2))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TERMS_PER_CATEGORY)
      .map(([t]) => t);
    lines.push(`- ${cat} (${n}): ${top.join(", ")}`);
  }
  let out = lines.join("\n");
  while (out.length > maxChars && lines.length > 1) {
    lines.pop();
    out = `${lines.join("\n")}\n- …`;
  }
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}

const topicCache = new WeakMap<MemoryRepository, { sig: string; map: string | null }>();
const TOPIC_SOURCE_LIMIT = 500;

/** The topic map, recomputed only when memories changed (count / last update). */
export function topicMap(repo: MemoryRepository): string | null {
  const sig = repo.signature();
  const cached = topicCache.get(repo);
  if (cached && cached.sig === sig) return cached.map;
  const map = buildTopicMap(repo.list({ status: "current", limit: TOPIC_SOURCE_LIMIT }));
  topicCache.set(repo, { sig, map });
  return map;
}

export interface CoreContext {
  pinned: Memory[];
  topicMap: string | null;
  /** Tokens left for search-selected memories after pinned + topic map. */
  remainingTokens: number;
}

/**
 * Splits the memory token budget: pinned first (they are always true for the owner), then the topic
 * map when it still fits, then whatever is left goes to search-selected memories.
 */
export function coreContext(repo: MemoryRepository, budgetTokens: number): CoreContext {
  let remaining = budgetTokens;
  const pinned: Memory[] = [];
  for (const m of pinnedForPrompt(repo)) {
    const cost = estimateTokens(m.content) + 8;
    if (cost > remaining) continue;
    remaining -= cost;
    pinned.push(m);
  }
  let map: string | null = null;
  try {
    map = topicMap(repo);
  } catch (error) {
    console.warn("topic map skipped", error instanceof Error ? error.message : String(error));
  }
  if (map) {
    const cost = estimateTokens(map) + 16;
    // The map is a hint; it never takes more than a quarter of what remains.
    if (cost <= remaining / 4) remaining -= cost;
    else map = null;
  }
  return { pinned, topicMap: map, remainingTokens: Math.max(0, remaining) };
}
