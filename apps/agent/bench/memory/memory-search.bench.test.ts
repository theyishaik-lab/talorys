// Memory search benchmark (offline, NOT part of `npm test`): loads a Hebrew/English memory
// fixture into a real Durable Object SQLite database (workerd, FTS5) and scores the legacy
// pre-16 search (default unicode61 index + English-only query builder) against the Hebrew-aware
// search (schema 16) on recall@8 and MRR — the same 8 the prompt recall takes. When the fixture has
// precomputed bge-m3 vectors beside it (`<fixture>.embeddings.json`, made by embed_fixture.py), a
// third column runs the real hybrid recall (`hybridSearch`: BM25 + vectors fused by RRF, with the
// production floors) using those vectors instead of Workers AI, so it stays offline and free.
//   npm run bench:memory -w @talorys/agent
//   BENCH_MEMORY_FIXTURE_FILE=/path/to/real.json npm run bench:memory -w @talorys/agent   # local data, never commit
//     (reads /path/to/real.embeddings.json when present)
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Memory } from "@talorys/shared";
import { inAgent } from "../../test/helpers";
import { legacyFtsQuery } from "../../src/db/search-text";
import { likePattern } from "../../src/db/database";
import type { TalorysAgent } from "../../src/agent/talorys-agent";
import { writeSemanticConfig } from "../../src/semantic/config";
import { type Embedder, contentHash } from "../../src/semantic/embeddings";
import { runIndexer } from "../../src/semantic/indexer";
import { createSemanticContext, hybridSearch } from "../../src/semantic/recall";
import synthetic from "./fixture.json";
import syntheticVectors from "./fixture.embeddings.json";

interface Fixture {
  memories: { key: string; content: string; category?: string }[];
  queries: { q: string; relevant: string[]; tags?: string[] }[];
}

const K = 8;
const E = env as unknown as Record<string, string>;
const fixture: Fixture = E.BENCH_MEMORY_FIXTURE ? JSON.parse(E.BENCH_MEMORY_FIXTURE) : (synthetic as Fixture);

interface VectorCache { model: string; dims: number; vectors: Record<string, string> }
const vectorCache: VectorCache | null = E.BENCH_MEMORY_FIXTURE
  ? E.BENCH_MEMORY_EMBEDDINGS ? JSON.parse(E.BENCH_MEMORY_EMBEDDINGS) : null
  : (syntheticVectors as VectorCache);

/** Serves precomputed vectors (int8 + scale, keyed by sha256(text)[:16]); a text without one throws. */
class CachedEmbedder implements Embedder {
  constructor(private readonly cache: VectorCache) {}
  get model() { return this.cache.model; }
  get dims() { return this.cache.dims; }
  async embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map(async (t) => {
      const entry = this.cache.vectors[(await contentHash(t)).slice(0, 16)];
      if (!entry) throw new Error(`No precomputed vector for: ${t.slice(0, 60)}`);
      const [scale, b64] = entry.split(":") as [string, string];
      const bytes = Int8Array.from(atob(b64), (c) => (c.charCodeAt(0) << 24) >> 24);
      return Float32Array.from(bytes, (x) => x * Number(scale));
    }));
  }
}

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

it("memory search benchmark: legacy vs Hebrew-aware BM25 vs hybrid", async () => {
  await inAgent(async (a) => {
    const repo = a.services.memories;
    repo.clear();
    const keyOf = new Map<string, string>();
    for (const m of fixture.memories) keyOf.set(repo.create({ content: m.content, category: (m.category ?? "other") as Memory["category"] }).id, m.key);
    const run = (fn: (q: string) => Memory[]) => fixture.queries.map((c) => fn(c.q).map((m) => keyOf.get(m.id) ?? "?"));
    const before = run((q) => legacy(a, q));
    const after = run((q) => repo.search(q, K, undefined, "current"));
    const rel = fixture.queries.map((c) => c.relevant);
    let hybrid: string[][] | null = null;
    if (vectorCache) {
      const config = writeSemanticConfig(a.services.settings, { enabled: true, model: vectorCache.model, maxEmbeddingsPerDay: 10_000 }, a.services.db);
      const ctx = { ...createSemanticContext(a.services, env as never, config), embedder: new CachedEmbedder(vectorCache) };
      const report = await runIndexer(ctx, { maxEmbed: 10_000 });
      if (report.error || report.pending > 0) throw new Error(`Indexing the fixture failed: ${report.error ?? `${report.pending} pending`}`);
      hybrid = [];
      for (const c of fixture.queries) hybrid.push((await hybridSearch(ctx, c.q, { limit: K })).map((h) => keyOf.get(h.memory.id) ?? "?"));
    }

    const tags = ["all", ...new Set(fixture.queries.flatMap((c) => c.tags ?? []))];
    const fmt = (x: number) => x.toFixed(3);
    const h = hybrid ? " / hybrid" : "";
    const lines = [
      `memories=${fixture.memories.length} queries=${fixture.queries.length} k=${K}${hybrid ? ` vectors=${vectorCache!.model}` : " (no vectors: hybrid skipped)"}`,
      `columns: legacy / BM25${h}`,
      `| slice | n | recall@8 | MRR | hit@1 | zero-hit |`,
      "|---|---|---|---|---|---|",
    ];
    const cols = (idx: number[], pick: (m: Score) => number, f: (x: number) => string) =>
      [before, after, ...(hybrid ? [hybrid] : [])].map((runs) => f(pick(score(idx.map((i) => runs[i]!), idx.map((i) => rel[i]!))))).join(" / ");
    for (const tag of tags) {
      const idx = fixture.queries.map((c, i) => (tag === "all" || c.tags?.includes(tag) ? i : -1)).filter((i) => i >= 0);
      lines.push(`| ${tag} | ${idx.length} | ${cols(idx, (m) => m.recall, fmt)} | ${cols(idx, (m) => m.mrr, fmt)} | ${cols(idx, (m) => m.hit1, fmt)} | ${cols(idx, (m) => m.zero, String)} |`);
    }
    lines.push("", `Per query MRR (legacy → BM25${hybrid ? " → hybrid" : ""}), top keys of the best run:`);
    fixture.queries.forEach((c, i) => {
      const s = (r: string[]) => score([r], [c.relevant]).mrr.toFixed(2);
      const top = (hybrid ?? after)[i]!.slice(0, 4).join(",");
      lines.push(`${s(before[i]!)} → ${s(after[i]!)}${hybrid ? ` → ${s(hybrid[i]!)}` : ""}  ${c.q}  [${c.relevant.join(",")}]  top: ${top}`);
    });
    console.log(`\nMEMORY SEARCH BENCH\n${lines.join("\n")}\n`);
    const all = score(after, rel);
    expect(all.recall).toBeGreaterThanOrEqual(score(before, rel).recall);
    if (hybrid) expect(score(hybrid, rel).recall).toBeGreaterThanOrEqual(all.recall);
  });
});
