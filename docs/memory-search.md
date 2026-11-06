# Memory search (keyword, Hebrew-aware)

Memories and notes are found by keyword with SQLite FTS5 and BM25 ranking. This is what fills the
prompt (8 memories per turn, see `src/agent/memory.ts`) when semantic recall is off, and it is one of
the two lists semantic recall fuses (RRF) when it is on. Chat messages have their own trigram index
(`src/db/message-search.ts`).

## Why Hebrew needs help

SQLite's `unicode61` tokenizer splits on spaces and punctuation only. In Hebrew that misses most real
queries: prefixes are glued to the word (`בתל אביב`, `והילדה`, `לבית`, `שהקרן`), niqqud and
cantillation are separate code points that break a token, final letters (`ך ם ן ף ץ`) differ from
their medial forms (`שולחן` vs `שולחנות`), and abbreviations carry gershayim (`צה"ל`). Durable Object
SQLite has no custom tokenizers or SQL functions, so normalization happens in JS.

## How it works (schema 16)

- `src/db/search-text.ts` normalizes text: NFKD, strip Hebrew points and cantillation, join
  gershayim/geresh abbreviations, maqaf → space, final letters → medial, lower-case.
- Each Hebrew token also yields prefix-stripped stems: up to two prefix letters from `ו ה ב ל מ ש כ`
  (`ו` only first), stem at least 2 letters. The original token is always kept.
- Index tables `tal_memories_search(body, stems)` and `tal_notes_search(title, body, stems)` hold the
  normalized text. BM25 weights: memories `1.0, 0.5`; notes `2.0, 1.0, 0.5` — exact words outrank stem
  matches.
- Triggers on `tal_memories` / `tal_notes` only queue rowids in `tal_search_dirty`;
  `syncSearchIndex()` re-indexes them before every search and once after migrating, so every write
  path (repositories, backup import, raw SQL) is covered. Migration 16 queues every existing row
  (full reindex on first use).
- `ftsQuery()` applies the same normalization to the query, drops English and Hebrew stop words, and
  ORs each word (prefix match) with its stems (prefix match only for 3+ letters, so `תל` stays exact).
  English queries produce exactly the pre-16 expression.
- Fallbacks: if the new index fails, the legacy `tal_*_fts` index (kept, still trigger-maintained)
  with the old query builder; with no indexable terms, `LIKE`.

## Benchmark

`npm run bench:memory -w @talorys/agent` (offline, free, real FTS5 inside workerd). It loads
`apps/agent/bench/memory/fixture.json` — 60 synthetic Hebrew/English memories and 42 queries
(prefixes, niqqud, final letters, gershayim, mixed language, English) — and compares the legacy search
with the current one on recall@8, MRR and hit@1. Run against a private fixture with
`BENCH_MEMORY_FIXTURE_FILE=/path/file.json`; never commit real personal memories.

Results at schema 16 (synthetic fixture):

| slice | n | recall@8 before → after | MRR before → after | queries with no hit |
| --- | --- | --- | --- | --- |
| all | 42 | 0.843 → 0.950 | 0.798 → 0.960 | 5 → 0 |
| Hebrew | 29 | 0.772 → 0.928 | 0.730 → 0.966 | 5 → 0 |
| prefixes | 18 | 0.833 → 0.972 | 0.731 → 0.944 | 3 → 0 |
| English | 8 | 1.000 → 1.000 | 0.917 → 0.917 | 0 → 0 |

What keyword search still cannot do: synonyms and paraphrase (`לאשתי` vs a memory naming the
partner), and cross-language matches (a Hebrew question about a memory written in English). Those
need semantic recall ([semantic-recall.md](semantic-recall.md)).

## Follow-ups

- Message search already uses trigram (substring) matching, which handles prefixes; it does not
  strip niqqud or fold final letters yet.
