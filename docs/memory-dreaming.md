# Core memory and nightly memory dreaming

Stage 1 of the memory upgrade (inspired by Alfred's Napkin memory, Nov 2026). Before it, memories
were saved only when the chat model called `remember`, which it rarely did. Now three things work
together:

1. **Core memory (pinned)** — a few facts that are always in the prompt.
2. **Nightly dreaming** — once a night the agent reads the day's conversations and updates its memory.
3. **Topic map** — a short keyword overview of everything else, so the model knows what
   `search_memories` can find.

All three live inside the existing memory token budget (`memoryTokenBudget`: a fifth of the context
budget, at most 1,500 tokens): pinned first, then the topic map (never more than a quarter of what
is left), then the search-selected memories.

## Core memory

- Up to **30 items / 2,000 characters** (`PINNED_MEMORY_LIMITS` in `packages/shared`).
- Shown in every chat and scheduled run as "Core memory — always true about the owner".
- Changed **only by the owner**: the pin icon on the Memory page (web) or the memory list (app), or
  `POST /api/memories/:id/pin`. In chat, the model pins only when the owner explicitly says to
  *always* remember something (`remember` with `pin: true`).
- Never touched by automatic processes: dreaming cannot add, change or retire a pinned memory;
  `update_memory` refuses pinned memories; a conflicting new memory never supersedes a pinned one
  (it goes to the owner's review instead).
- Stored in `tal_memory_pins` (migration 15); travels with backups.

## Nightly dreaming

A managed automation, **"Talorys memory dreaming"**, runs daily at **03:00 in the owner's timezone**
(Settings → timezone). Settings → AI → **Learn overnight** turns it off (`memoryHistory.dreaming`,
default on). The Memory page's **Learn now** runs a pass immediately.

A pass (`apps/agent/src/memory/dreaming.ts`):

1. Collects unseen (owner message, reply) pairs from live chats since the last pass (14 days at
   most), newest 40, each clipped to 600 characters, secret-looking text redacted. Each pair is
   fingerprinted (SHA-256) in `tal_memory_dream_seen` so it is read only once. No new turns → no
   AI request.
2. Snapshots up to 80 current memories (pinned first, marked read-only).
3. Asks the **existing model chain** (same order and fallbacks as chat, no tools, JSON only,
   at least 4,096 output tokens so reasoning models have room) for a plan:
   `{upserts: [{text, category, turn, reason}], markPast: [{id, reason}], summary}`. The prompt is
   Alfred's rules: the data is untrusted; store only what the owner stated or confirmed; no small
   talk or credentials; merge duplicates; at most 16 operations; never touch pinned; respect dates;
   **write each memory in the language the owner used** (see below).
4. Validates locally: secret patterns, 8–500 characters, known categories only (nothing can be
   pinned), operation cap; a retirement must name exactly one current, non-pinned memory (by id, or
   a unique substring).
5. Applies: outdated memories are **marked as past** (kept as history, never deleted), new ones are
   saved through `MemoryHistoryService` with source `dream`, so the usual conflict and history rules
   run.
6. Writes an audit row to `tal_memory_dream_runs`: time, trigger, turns read, changes (for undo),
   refused operations, summary, the model that answered, error.

### Language (Nov 6, 2026)

Memories are written in the owner's language, not translated: a Hebrew conversation gives Hebrew
memories ("המשתמש גר בתל אביב."), an English one English memories. Before this, the prompt's English
example ("The owner …") made the model write English even from Hebrew chats, and Hebrew questions
then found nothing by keyword (all 5 live memories were English).

- Every turn in the prompt carries `n` and `lang` (`he`/`en`, from the share of Hebrew letters in
  the owner's message: a quarter or more is Hebrew, so English names and code inside Hebrew text
  don't flip it), and the payload carries `owner_language` (the language of most turns, or `mixed`).
  The model names each addition's source turn in `turn`.
- After parsing, `languageMismatches` checks each addition against its source turn's language (or
  the pass's main language when it named none). A Hebrew memory needs at least a quarter Hebrew
  letters; an English one may hold Hebrew names but not be mostly Hebrew.
- Mismatches get **one** rewrite request ("rewrite these in Hebrew, keep names and code"); a rewrite
  that is in the right language and passes the usual checks replaces the text, anything else is
  refused with "not written in the owner's language" and shows in the pass's refused list.
- Existing English memories are left as they are; translating them is a separate, owner-approved step.

Budget: one AI request per pass (two when a rewrite is needed), counted against **AI requests per day**; a nightly pass also counts
as one **scheduled AI run** and is skipped when either budget is used up. If the chain fails or the
reply is not JSON, nothing changes and the turns are read again next time.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/memories/pinned` | Pinned memories and usage against the limits |
| POST | `/api/memories/:id/pin` | `{pinned: boolean}`; 400 when core memory is full |
| POST | `/api/memories` | accepts `pinned: true` to pin on create |
| GET | `/api/memories/dreaming?limit=10` | `{enabled, next_run, runs}` — "What was learned" |
| POST | `/api/memories/dreaming/run` | Runs a pass now; returns the run |
| POST | `/api/memories/dreaming/runs/:id/undo` | `{index}`: undo one change (an added memory is deleted and what it replaced becomes current again; a memory marked past gets its old status back) |

## UI

- **Web, Memory page:** "Core memory" (usage, unpin), "Learned recently" (changes of the last
  passes with Undo, **Learn now**, next pass), a pin button on every current memory.
- **App, Memory screen:** pin/unpin per memory, core memories listed first. (Needs a new APK.)
- **Settings → AI → Memory history:** "Learn overnight".

See also [memory-history.md](memory-history.md) for statuses, conflicts and history.
