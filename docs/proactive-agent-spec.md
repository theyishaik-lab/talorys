# Talorys Proactive — full build spec

**Status:** draft v1 · **Date:** 2026-10-16 · **Owner:** Yishai

**Goal in one line:** extend Talorys from a *reactive* personal agent (you ask, it
answers) into a *proactive* "operating system for your life" — it watches your context,
spots opportunities, and proposes actions you approve — as an **original implementation**
on Talorys's existing Cloudflare/Agents-SDK foundation.

This is a clean-room reimplementation of a product *category* (proactive life-OS agents).
It copies no code, assets, branding, or trademarked names from any existing product. The
design below is grounded entirely in Talorys's current source.

### Scope decisions — locked 2026-10-16

1. **Money:** v1 is **information + non-spend actions only**. No credential vault, no spend
   guardrails, no commerce/booking connectors in v1 — all deferred to a later phase.
2. **Connectors first:** **email + calendar + drive** (read-focused OpenConnector actions).
3. **Timing:** daily briefing **08:00**; proactive scan **every 3h**. Both owner-adjustable.
4. **Platform:** **web-only for v1**; native mobile is a planned future milestone (post-v1).

Effect on the roadmap: Phases 1–2 (engine, non-AI then AI) + Life-OS layer form **v1**.
Vault (Phase 3) and connector-expansion/spend (Phase 4) move **after** v1.

---

## 1. What already exists in Talorys (the foundation)

The proactive-agent category needs four primitives. Talorys already has all four:

| Primitive needed | Talorys has it as | File |
| --- | --- | --- |
| Act on your behalf in real services | OpenConnector tools (`gmail.search_threads`, …); read verbs auto-run, writes need approval | `apps/agent/src/openconnector/` |
| Propose an action, wait for consent | `PendingActionRepository` + `ConnectCard`, `prepare`/`commit`, 30-min TTL, approve-by-id | `apps/agent/src/db/repositories/pending-actions.ts`, `tools/registry.ts` |
| Think ahead on a schedule | `AutomationService` over Durable Object alarms; kinds `reminder` / `agent_prompt`; DST-correct `computeNextRun` | `apps/agent/src/agent/scheduling.ts` |
| Deliver results when you're away | Push / in-app notification center | `apps/agent/src/push/` |

Plus: memory (+ optional semantic recall), tasks/notes/projects, per-day AI budget guards,
single-user auth, SQLite-in-DO storage, append-only migrations.

**Conclusion:** we are ~70–80% of the way to the category already. The work is a *proactive
engine* that orchestrates these primitives, a *credential vault*, more *connectors*, and a
*Life-OS* presentation layer.

---

## 2. Capability gap analysis

Category features (left) mapped to the delta we must build (right):

1. **"Thinks ahead / spots opportunities"** → a **Proactive Engine**: scheduled background
   runs that scan signals (calendar, inbox, tasks, memory, time) and emit *suggestion cards*
   to the notification center. (New; builds on automations + push + pending-actions.)
2. **"Does things for you" (buy, book, pay)** → **more connectors** + the existing
   approval-gated action path. (Extend OpenConnector; little new core.)
3. **"Encrypted vault for cards & logins"** → a **Credential Vault**: owner-encrypted secrets
   the agent can *request to use* but never read in plaintext into the model. (New module.)
4. **"Tracks life/work/school"** → **Life-OS layer**: contexts/areas + a unified **daily
   briefing**. (New presentation + light data model.)

---

## 3. Architecture overview

```
                    ┌─────────────────────── TalorysAgent (DO) ───────────────────────┐
Automations/alarms ─▶│  Proactive Engine  ──signals──▶ candidate suggestions           │
                    │        │                              │                           │
                    │        │                       budget + dedupe + policy           │
                    │        ▼                              ▼                           │
   OpenConnector ◀──┤   action tools (read auto / write=PendingAction)   Suggestion store │
   (gmail, …) ──────┤        ▲                              │                           │
                    │   Credential Vault (AES-GCM) ─used by─┘            Push/Notif center │
                    └──────────────────────────────────────────────────────────────────┘
                                   browser ◀── SSE/notifications ── approval cards
```

Design rules (inherited, non-negotiable):
- Tools touch only the owner's data through the service layer. No shell, no arbitrary
  network except through a vetted connector.
- Every state-changing or money-spending action is a **DestructiveTool**: `prepare`
  (resolve exact target, build a `ConnectCard`) → owner approves that exact id → `commit`.
- Scheduled (proactive) runs are **read-only + notify**: they may *propose* via a card but
  never auto-commit a destructive action. (`ToolContext.mode === "scheduled"` already enforces this.)

---

## 4. Module specs

### 4.1 Proactive Engine (the core — "the DNA")

**Idea:** on a schedule (and opportunistically after events), run a bounded "scan" that turns
the owner's current context into 0–N *suggestions*, each of which is either informational or
carries a proposed action the owner can approve.

**Data model** (new migration, append-only):
```sql
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'opportunity' | 'reminder' | 'digest' | 'action_proposal'
  title TEXT NOT NULL,
  body TEXT NOT NULL,              -- markdown shown in the card
  signal_hash TEXT NOT NULL,       -- dedupe key (don't resurface the same thing)
  proposed_tool TEXT,              -- nullable; the DestructiveTool to run on approve
  proposed_input TEXT,             -- JSON, validated by that tool's schema at approve time
  status TEXT NOT NULL,            -- 'new' | 'seen' | 'accepted' | 'dismissed' | 'expired'
  score REAL NOT NULL,             -- relevance; only top-K per run are emitted
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX idx_suggestions_status ON suggestions(status, created_at);
```

**Signals (v1, all local, zero extra cost):** time-of-day/day-of-week, upcoming tasks & due
dates, reminders, recent memories, unread connector items *only if a connector is already
connected* (e.g. flagged email). Each signal is a small typed record with a `source` and a
`signal_hash`.

**Pipeline per run:**
1. Gather signals (read-only, cap total tokens).
2. One AI call (respecting the daily AI-request budget) ranks/forms ≤ `maxSuggestionsPerRun`
   suggestions. Non-AI signals (a task due today) can emit a suggestion *without* AI, so the
   engine still works when the AI quota is exhausted — mirrors Talorys's "works without AI".
3. Dedupe by `signal_hash` against recent suggestions.
4. Persist top-K; push a notification for any `kind: action_proposal` or high score.

**Action proposals:** when a suggestion proposes a tool, approving it calls the normal
`prepare`→`commit` path with the stored `proposed_input` re-validated against the tool schema.
No new trust path — reuses pending-actions.

**Controls (Settings → Proactive):** master on/off, scan frequency, max suggestions/run,
quiet hours, per-category mute, and a hard cap on proactive AI runs/day (the
`maxScheduledAiRuns` guard already exists).

**New tools:** `proactive.list_suggestions` (read), `proactive.dismiss` (write). Creating
suggestions is engine-internal, not a model-callable tool.

**Files to add:** `apps/agent/src/proactive/engine.ts`, `.../signals.ts`, `.../repository.ts`,
tool module `apps/agent/src/tools/proactive.ts`, wire into `tools/index.ts` and the
automation executor in `scheduling.ts` (a new automation kind `proactive_scan`).

### 4.2 Credential Vault

**Idea:** store secrets (card numbers, site logins) so the agent can *use* them for an
approved action, without ever putting plaintext secrets into the model's context or logs.

**Crypto:** envelope encryption with WebCrypto **AES-GCM**. A vault key is derived from the
owner password (PBKDF2 already in `packages/shared/src/crypto.ts`, 100k iters) via HKDF into a
per-install vault master key; each secret encrypted with a fresh 96-bit IV. Only ciphertext +
IV + a non-secret label/metadata live in SQLite.
```sql
CREATE TABLE vault_items (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,             -- "Visa ••1234", "example.com login" (non-secret)
  category TEXT NOT NULL,          -- 'card' | 'login' | 'note'
  ciphertext TEXT NOT NULL,        -- base64url(AES-GCM)
  iv TEXT NOT NULL,
  meta TEXT,                       -- non-secret JSON (last4, site host)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

**Access rule (critical):** the model can see only **labels/metadata**, never plaintext. A
secret is decrypted **inside a `commit`** of an approved action, injected directly into the
outbound connector call, and zeroed after. The `leak-guard` (`apps/agent/src/ai/leak-guard.ts`)
is extended to redact any vault plaintext that somehow reaches a model-bound string.

**Tools:** `vault.list` (read, labels only), `vault.add`/`vault.remove` (destructive, owner
card). No `vault.get_plaintext` tool exists — by design.

**Files:** `apps/agent/src/vault/{service,repository,crypto}.ts`, `tools/vault.ts`, leak-guard
extension, migration.

### 4.3 Connector expansion

Reuse the OpenConnector action model. v1 target set (behind owner approval for writes):
calendar, email, a shopping/commerce connector, a maps/booking connector. No bespoke
scraping; every action goes through a vetted connector action id with the read/write verb
policy already in `openconnector/tools.ts`. Where a real service lacks a connector, stub it
as a **simulated connector** in dev (the mock-AI pattern already exists) so flows are testable
without a live account.

### 4.4 Life-OS layer

- **Areas/contexts:** a light tag on tasks/notes/memories (`area: life|work|school|custom`).
  Migration adds a nullable `area` column; UI filter.
- **Daily briefing:** a built-in `agent_prompt` automation (e.g. 08:00) that composes
  "today": due tasks, calendar, open suggestions, overnight connector flags → one briefing
  pushed to the notification center. Non-AI fallback lists tasks/reminders only.

---

## 5. Consent & safety model (money is involved)

This is the part that must be right.

1. **No silent spend, ever.** Any action that moves money or data off-account is a
   DestructiveTool requiring explicit per-action approval on a card that shows the *exact*
   amount, merchant, and item. Scheduled runs can only *propose*.
2. **Spending guardrails:** per-action and per-day spend ceilings in Settings; a proposal
   over the ceiling is blocked (not just warned). Stored as owner settings.
3. **Vault isolation:** secrets never enter model context or logs (§4.2).
4. **Reversibility bias:** proposals prefer cancellable/refundable options; the card notes
   when an action is irreversible.
5. **Audit log:** an append-only `action_log` (who/what/when/amount/result) the owner can review.
6. **Rate & budget:** proactive AI runs counted against the existing daily AI budget; a
   dedicated `maxScheduledAiRuns` cap prevents runaway scans.

---

## 6. Phased roadmap

- **Phase 0 — spec & scaffolding (this doc).** Agree scope; add migrations skeleton; feature
  flag `proactive` off by default.
- **Phase 1 — Proactive Engine, non-AI signals only.** Suggestions from tasks/reminders/time;
  notification center cards; list/dismiss tools; Settings panel. *Ships value with zero AI cost.*
- **Phase 2 — AI ranking + action proposals.** One budgeted AI call to form/rank suggestions;
  approve → existing pending-action path; audit log.
- **Phase 3 — Credential Vault.** AES-GCM envelope, labels-only to model, leak-guard extension.
- **Phase 4 — Connector expansion + spend guardrails.** Commerce/booking connectors (simulated
  first), per-action/day ceilings, irreversibility notes.
- **Phase 5 — Life-OS layer.** Areas + daily briefing.

Each phase is independently shippable and testable (`npm test` + Playwright e2e), behind the
feature flag until complete.

---

## 7. Non-goals / risks / open questions

**Non-goals (v1):** multi-user; a mobile app (Talorys is a responsive web app — revisit later);
autonomous spending without approval; scraping sites that lack a connector.

**Risks:** (a) AI free-quota limits cap how "proactive" we can be — mitigated by non-AI
signals and strict budgets; (b) vault is high-value — keep plaintext out of model/logs and
test the leak-guard hard; (c) connector coverage for real commerce/booking may be thin —
start simulated, add real connectors as available.

**Open questions for Yishai:**
1. Which real connectors matter first (email+calendar? shopping? bills?)?
2. Is money-spending in scope for v1, or start with information + non-spend actions only?
3. Daily-briefing time and default scan frequency?
4. Keep it web-only, or is a mobile/PWA wrapper wanted early?
