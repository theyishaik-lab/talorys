// Memory search benchmark (offline, NOT part of `npm test`): loads a Hebrew/English memory
// fixture into a real Durable Object SQLite database (workerd, FTS5) and scores the legacy
// pre-16 search (default unicode61 index + English-only query builder) against the Hebrew-aware
// search (schema 16) on recall@8 and MRR — the same 8 the prompt recall takes.
//   npm run bench:memory -w @talorys/agent
//   BENCH_MEMORY_FIXTURE_FILE=/path/to/real.json npm run bench:memory -w @talorys/agent   # local data, never commit
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Memory } from "@talorys/shared";
import { inAgent } from "../../test/helpers";
import { legacyFtsQuery } from "../../src/db/search-text";
import { likePattern } from "../../src/db/database";
import type { TalorysAgent } from "../../src/agent/talorys-agent";
import synthetic from "./fixture.json";

interface Fixture {
  memories: { key: string; content: string; category?: string }[];
  queries: { q: string; relevant: string[]; tags?: string[] }[];
}

const K = 8;
const E = env as unknown as Record<string, string>;
const fixture: Fixture = E.BENCH_MEMORY_FIXTURE ? JSON.parse(E.BENCH_MEMORY_FIXTURE) : (synthetic as Fixture);

/** The search as it was before schema 16 (legacy FTS index, LIKE when no indexable terms). */
function legacy(a: TalorysAgent, q: string): Memory[] {
  const repo = a.services.memories;
  const match = legacyFtsQuery(q);
  if (match) return repo.legacySearch(match, K, undefined, "current");
  return a.services.db.all<Memory>(
    `SELECT * FROM tal_memories WHERE content LIKE ? ESCAPE '\\' AND status != 'historical' ORDER BY updated_at DESC LIMIT ?`,
    likePattern(q), K,
  );
}

interface Score { recall: number; mrr: number; hit1: number; zero: number }

function score(results: string[][], relevant: string[][]): Score {
  let recall = 0, mrr = 0, hit1 = 0, zero = 0;
  results.forEach((r, i) => {
    const rel = new Set(relevant[i]);
    const found = r.filter((k) => rel.has(k)).length;
    recall += found / rel.size;
    const first = r.findIndex((k) => rel.has(k));
    if (first >= 0) mrr += 1 / (first + 1);
    if (first === 0) hit1++;
    if (found === 0) zero++;
  });
  const n = results.length || 1;
  return { recall: recall / n, mrr: mrr / n, hit1: hit1 / n, zero };
}

it("memory search benchmark: legacy vs Hebrew-aware BM25", async () => {
  await inAgent((a) => {
    const repo = a.services.memories;
    repo.clear();
    const keyOf = new Map<string, string>();
    for (const m of fixture.memories) keyOf.set(repo.create({ content: m.content, category: (m.category ?? "other") as Memory["category"] }).id, m.key);
    const run = (fn: (q: string) => Memory[]) => fixture.queries.map((c) => fn(c.q).map((m) => keyOf.get(m.id) ?? "?"));
    const before = run((q) => legacy(a, q));
    const after = run((q) => repo.search(q, K, undefined, "current"));
    const rel = fixture.queries.map((c) => c.relevant);

    const tags = ["all", ...new Set(fixture.queries.flatMap((c) => c.tags ?? []))];
    const fmt = (x: number) => x.toFixed(3);
    const lines = [`memories=${fixture.memories.length} queries=${fixture.queries.length} k=${K}`, "| slice | n | recall@8 before | recall@8 after | MRR before | MRR after | hit@1 before | hit@1 after | zero-hit before | zero-hit after |", "|---|---|---|---|---|---|---|---|---|---|"];
    for (const tag of tags) {
      const idx = fixture.queries.map((c, i) => (tag === "all" || c.tags?.includes(tag) ? i : -1)).filter((i) => i >= 0);
      const b = score(idx.map((i) => before[i]!), idx.map((i) => rel[i]!));
      const r = score(idx.map((i) => after[i]!), idx.map((i) => rel[i]!));
      lines.push(`| ${tag} | ${idx.length} | ${fmt(b.recall)} | ${fmt(r.recall)} | ${fmt(b.mrr)} | ${fmt(r.mrr)} | ${fmt(b.hit1)} | ${fmt(r.hit1)} | ${b.zero} | ${r.zero} |`);
    }
    lines.push("", "Per query (before → after, top keys):");
    fixture.queries.forEach((c, i) => {
      const s = (r: string[]) => score([r], [c.relevant]);
      lines.push(`${s(before[i]!).mrr.toFixed(2)} → ${s(after[i]!).mrr.toFixed(2)}  ${c.q}  [${c.relevant.join(",")}]  after: ${after[i]!.slice(0, 4).join(",")}`);
    });
    console.log(`\nMEMORY SEARCH BENCH\n${lines.join("\n")}\n`);
    const all = score(after, rel);
    expect(all.recall).toBeGreaterThanOrEqual(score(before, rel).recall);
  });
});
