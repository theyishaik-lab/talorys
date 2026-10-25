# Talorys — Full Build Roadmap

**Status:** living document · **Updated:** 2026-10-25 · **Owner:** Yishai

---

## 0. North Star

Talorys evolves from a personal AI chat agent into a **personal operating system** — it watches your context, connects to your services, takes actions you approve, and eventually extends onto every device you own (Android keyboard, device assistant, mobile app).

Everything runs in your own Cloudflare account. No server operated by anyone else. No telemetry.

---

## 1. Current State

### ✅ Built and shipped
| Module | Description | Entry point |
|--------|-------------|-------------|
| Core agent | Hono + Cloudflare Agents SDK DO, SQLite, SSE streaming | `apps/agent/src/agent/talorys-agent.ts` |
| Memory | Durable facts, history, optional semantic recall | `src/db/repositories/memories.ts` |
| Tasks / Notes / Projects | Full CRUD, chat-accessible | `src/db/repositories/` |
| Automations | DO alarms, `reminder` + `agent_prompt`, DST-correct | `src/agent/scheduling.ts` |
| OpenConnector (runtime) | MCP bridge to external services (gmail, gcal, gdrive) | `src/openconnector/` |
| OpenConnector (connect flow) | Agent self-connect via destructive-tool approval | `src/openconnector/connect.ts` |
| Pending actions | prepare → approve → commit with ConnectCard UI | `src/db/repositories/pending-actions.ts` |
| Push / notifications | Web Push + in-app notification center | `src/push/` |
| Model chain editor | Multi-model cascade (OVH, Groq, Workers AI) | `apps/web/src/components/ModelPicker.tsx` |
| Hebrew UI | Full i18n, RTL-aware | `apps/web/src/lib/i18n.ts` |
| Mobile (Android) | React Native / Metro build, basic screens | `apps/mobile/` |

### 🚧 In progress (uncommitted)
| Module | Status | Files |
|--------|--------|-------|
| Proactive engine Phase 1 | ~80% — engine.ts, tools, repository, migrations wired | `src/proactive/`, `src/tools/proactive.ts` |

### ❌ Not started
Connections page, UI overhaul, agent keyboard, Android device assistant, Phase 2–5 proactive.

---

## 2. Workstreams

Six parallel workstreams, ordered by dependency:

```
[A] Proactive Phase 1 finish  ──▶  [D] Proactive Phase 2 (AI)
[B] Connections page           ──▶  [D] feeds connector actions into proactive
[C] UI overhaul                (independent, runs in parallel)
[E] Agent keyboard             (independent, Android-side)
[F] Android device assistant   (depends on E + mobile app)
```

---

## 3. Workstream A — Proactive Engine Phase 1 (finish)

**Goal:** ship non-AI proactive suggestions from task/reminder signals, with a settings panel and notification center cards. Zero AI cost.

**What's done:** engine.ts scan loop, signal scoring, quiet hours, suggestions repository, `list_suggestions` / `dismiss_suggestion` tools, schema migrations, wired into container.

**What's missing:**
- [ ] `SuggestionsPage.tsx` — dedicated page (or embedded tab in Automations/Notifications)
- [ ] Settings UI panel — "Proactive" tab in Settings → master toggle, scan frequency, quiet hours, per-category mute
- [ ] `proactive_scan` automation kind — wire `runProactiveScan` into the scheduling executor
- [ ] Notification center card for suggestions — distinguish from regular notifications
- [ ] Tests — unit for `inQuietHours`, `runProactiveScan`; Playwright e2e for dismiss flow
- [ ] Feature flag → default on

**Done criteria:** `npm test` green, `npm run test:e2e` passes the proactive flows, suggestions appear in the notification center after a manual trigger, settings panel saves/loads.

**Owner:** Robin (Claude agent)

---

## 4. Workstream B — Connections Page

**Goal:** a dedicated `/connections` page that shows every connected service, its status and permissions, allows connecting new services, disconnecting, and (in v2) granular action-level permission control. Fully backed by the existing OpenConnector runtime — no new backend.

### 4.1 What OpenConnector already exposes (via `OpenConnectorClient`)

| MCP tool | What it returns |
|----------|----------------|
| `list_apps` | Catalog of all available services (id, displayName, categories, authType) |
| `list_connections` | Owner's active connections (service, connectionName, authType, profile) |
| `search_actions` | Actions available for a service or query |
| `get_action_guide` | Full action spec (inputs, description, read/write classification) |
| `execute_action` | Runs an action (read-only auto; write = pending-action) |

**Plus on the admin side** (`OpenConnectorAdmin`): `connect_service` (mint consent link + store API key) — already gated behind the destructive-tool approval flow.

### 4.2 New API routes needed (agent Worker)

```
GET  /api/connections           → list_connections (cached 30s)
GET  /api/connections/catalog   → list_apps (cached 5min)
GET  /api/connections/:id/actions → search_actions for that service
DELETE /api/connections/:id     → disconnect (new, calls OpenConnector admin)
POST /api/connections/connect   → initiate connect flow (wraps existing connect tools)
```

All routes are owner-authenticated (existing session middleware).

### 4.3 UI — `ConnectionsPage.tsx`

```
/connections

┌─────────────────────────────────────────────────────┐
│  CONNECTED SERVICES                    [+ Add service]│
├──────────────┬──────────────┬──────────────────────  │
│  Gmail       │  ✓ Connected │  yishai@gmail.com  [·] │
│  Google Cal  │  ✓ Connected │  primary calendar  [·] │
│  Google Drive│  ✗ Not connected          [Connect]   │
│  Linear      │  ✗ Not connected          [Connect]   │
│  …           │                                        │
└─────────────────────────────────────────────────────┘

Clicking [·] expands to show:
  - Auth type (OAuth2 / API key)
  - Available actions: list_events (read), create_event (write, needs approval), …
  - [Disconnect] button (confirm dialog)
```

**Components to build:**
- `ConnectionCard` — service logo, status badge, account name, expand chevron
- `ActionList` — grouped read/write, each with a small badge (auto-run vs. needs approval)
- `ConnectDialog` — wraps existing `connect_service` flow (OAuth redirect or API key input)
- `DisconnectConfirm` — single confirm dialog, calls DELETE route

### 4.4 Permission model (v1 vs. v2)

**v1 (this sprint):** show the existing read/write classification per action (already in `isReadOnlyAction`). No new permissions DB — just surface what's already enforced.

**v2 (post-v1):** per-action allow/deny list in a new `connection_permissions` SQLite table. The `execute_action` tool checks the list before running. Gives the owner fine-grained control ("Gmail: allow search, deny send").

**Done criteria (v1):** connections page loads, shows connected services, "Add" opens consent/API-key flow, "Disconnect" removes the connection, action list is visible per service.

---

## 5. Workstream C — UI Overhaul

**Goal:** elevate the UI to a modern, dense information design — closer to Linear or Notion than a basic SaaS template. Keep the existing component architecture; upgrade the design tokens and key pages.

### 5.1 Design principles
- **Information density** — more content visible at once (compact list items, collapsible sections)
- **Sidebar nav** — replace the mobile-first bottom bar with a persistent left sidebar on desktop
- **Command palette** — `Cmd+K` global search across tasks, notes, memories, actions
- **Dark-first** — refine the dark theme; add a true OLED-black option
- **Motion** — subtle transitions (page enter, card expand, notification pop); respect `prefers-reduced-motion`
- **Consistent spacing** — audit all pages against an 8px grid

### 5.2 Execution plan
1. **Design tokens** — update `apps/web/src/styles/` with new color, spacing, radius, shadow scales
2. **AppShell** — add collapsible sidebar (lg+), keep bottom nav for mobile
3. **Command palette** — `cmdk` library (already in many React stacks), index tasks/notes/memories/actions
4. **Page-by-page lift** — Chat → Tasks → Memory → Connections → Automations → Settings
5. **Component polish** — Card, Badge, Button, Dialog updated to new tokens

### 5.3 What NOT to change
- API contracts (no backend changes)
- i18n strings (Hebrew stays)
- Feature behavior (UI polish only)

**Done criteria:** Lighthouse accessibility score ≥ 90, no visual regressions in Playwright screenshots, sidebar nav works on lg+, command palette opens and searches.

---

## 6. Workstream D — Proactive Phase 2 (AI ranking + action proposals)

*Depends on A (Phase 1 done) and B (connections visible, actions available).*

**Goal:** one budgeted AI call per scan that ranks signals, forms richer suggestion cards, and can attach an action proposal the owner approves.

**New pieces:**
- `RankerService` — takes raw candidates from Phase 1 signals + connector signals, calls the model once, returns ranked `Suggestion[]` with optional `proposed_tool` / `proposed_input`
- Connector signals — if Gmail is connected, include flagged/unread count as a signal (read-only, zero writes in a scan)
- Action proposals — a suggestion card with an "Approve" button that fires the existing pending-action path
- Audit log — `action_log` table (append-only), populated on every `commit` of a proactive proposal
- Daily briefing automation — `agent_prompt` at 08:00, composes tasks + calendar + top suggestions → push notification

**Budget guard:** proactive AI calls counted against `maxScheduledAiRuns` (already exists in settings). Hard cap prevents runaway scans.

**Done criteria:** a scan with AI enabled produces ranked suggestions; an action proposal card shows "Approve" which commits via existing pending-action; audit log visible under Settings → Privacy.

---

## 7. Workstream E — Agent Keyboard + Screen Access

**Goal:** Talorys is accessible from anywhere on Android via a custom IME (keyboard) that surfaces suggestions, lets the user send a quick message to the agent, or trigger an action — without switching apps.

**Foundation:** `D:\Projects\agent-keyboard` — existing repo.

### 7.1 Architecture

```
Android IME (agent-keyboard)
    │  local IPC / HTTP (localhost)
    ▼
Talorys Mobile Companion (lightweight foreground service)
    │  WebSocket / SSE (same auth as web)
    ▼
Talorys Agent Worker (Cloudflare DO)
```

- The keyboard triggers the mobile companion, not Cloudflare directly — allows offline queuing and keeps latency low.
- Screen access via Android Accessibility Service — the companion reads the current app/text field context and sends it as a signal to the agent ("I see you're writing an email to X…").

### 7.2 Keyboard UI panels
| Panel | Trigger | Content |
|-------|---------|---------|
| Quick chat | Long-press mic | Sends message to agent, shows streaming reply |
| Suggestions strip | Auto | Top 2 proactive suggestions above the keyboard |
| Action strip | Agent proposes | "Send this email?" → one-tap approve |

### 7.3 Permissions required
- `BIND_INPUT_METHOD` — IME
- `BIND_ACCESSIBILITY_SERVICE` — screen reading
- `FOREGROUND_SERVICE` — companion always-on

### 7.4 Privacy model
- Screen content is summarized locally before sending (no raw screen dumps to the server)
- User can mute accessibility reading per-app (e.g. banking apps always excluded)
- All content goes through the same Talorys agent auth — no new trust boundary

**Done criteria:** keyboard installs as IME, quick-chat panel sends a message and shows the response, suggestions strip shows top-2 from the proactive engine.

---

## 8. Workstream F — Android Device Assistant

**Goal:** register Talorys as the Android device assistant (replaces Google Assistant / Gemini for the owner's device).

### 8.1 How Android device assistant works
- App declares `<activity android:name=".AssistActivity">` with `android.intent.action.ASSIST`
- Android calls it on long-press Home / voice button
- The activity receives a `Bundle` with the current app, screen text (AssistContent), and optionally a screenshot

### 8.2 Talorys AssistActivity
1. Receive AssistContent bundle (app package, window title, text on screen)
2. Pass context to the companion service → agent worker (same path as keyboard)
3. Show a compact overlay (not full-screen) with the agent's response
4. Support quick actions: "Add to tasks", "Save to memory", "Send to [connection]"

### 8.3 Trigger paths
| Trigger | Android mechanism |
|---------|------------------|
| Long-press Home | `ACTION_ASSIST` intent |
| "Hey Talorys" | `VoiceInteractionService` (requires extra permission flow) |
| Keyboard panel | Direct from Workstream E |

**Phase 1:** `ACTION_ASSIST` only (long-press Home). Voice activation is a later milestone.

**Done criteria:** Talorys appears as an option in Settings → Default apps → Digital assistant, long-press Home opens the overlay, agent receives screen context and responds.

---

## 9. Multi-Agent Build Approach

All build work follows these rules so multiple agents can work in parallel without conflicts:

### 9.1 Module boundaries
Each workstream maps to **one feature branch** and a **bounded set of files**:

| Branch | Owns |
|--------|------|
| `feat/proactive-phase1` | `src/proactive/`, `src/tools/proactive.ts`, `SuggestionsPage`, Settings Proactive tab |
| `feat/connections-page` | `src/openconnector/` (additive), `ConnectionsPage.tsx`, `ConnectionCard`, API routes |
| `feat/ui-overhaul` | `apps/web/src/styles/`, `AppShell`, global components only |
| `feat/proactive-phase2` | `src/proactive/ranker.ts`, `action_log` migration, `RankerService` |
| `feat/agent-keyboard` | `apps/mobile/` keyboard module, `AssistActivity` |

Cross-cutting changes (migrations, `container.ts`, `schemas.ts`) are **always additive** (append-only migrations, new optional fields in schemas) to avoid conflicts.

### 9.2 Handoff protocol
Every agent session that touches Talorys must:
1. `git pull origin main` before starting
2. Read `docs/AGENTS.md` for current instructions
3. Write a one-line entry to `docs/CHANGELOG-wip.md` when starting a session: `[date] [agent] starting [workstream] — [goal]`
4. Push or stash before ending the session — no orphaned local state

### 9.3 Review gates
No code merges to `main` without:
- `npm test` green (unit + integration)
- `npm run typecheck` clean
- At least one Playwright e2e test for the new flow
- The relevant Done Criteria from this doc checked

### 9.4 Tooling conventions
- **No `any`** — all new code is strictly typed
- **Migrations are append-only** — never alter an existing migration
- **Tools are additive** — new tools added to `tools/index.ts` via the existing `defineTool` pattern
- **Secrets never in tool results** — any new tool that touches credentials must pass the `leak-guard` check
- **Feature flags** — every workstream starts behind `settings.flags.<name>: false`

---

## 10. Sprint Plan (first two sprints)

### Sprint 1 — Foundation (this week)
| Task | Workstream | Owner |
|------|-----------|-------|
| Finish Phase 1 proactive — SuggestionsPage, Settings panel, scheduling wire-up | A | Robin |
| API routes for connections | B | Robin |
| `ConnectionsPage.tsx` — connected list, add, disconnect | B | Robin |
| Commit all open proactive changes | A | Robin |

### Sprint 2 — Connections + UI seeds
| Task | Workstream | Owner |
|------|-----------|-------|
| ActionList per service, read/write badge | B | Robin |
| Design token update + sidebar nav | C | Robin |
| Command palette (cmdk) | C | Robin |
| Phase 2 schema + RankerService skeleton | D | Robin |

### Post-sprint 2
Workstreams E and F (keyboard + device assistant) start after Sprint 2 — they need the connections page and proactive Phase 2 as a backend foundation.

---

## 11. Open Questions

1. **OpenConnector URL** — what is the production URL of connect.yishaik.com's connector endpoint? (Needed to wire `OPEN_CONNECTOR_URL` in prod.)
2. **Connections page scope** — v1 shows read/write classification only; v2 adds per-action allow/deny. OK to ship v1 first?
3. **Agent keyboard** — is `agent-keyboard` repo the right base, or start fresh inside `apps/mobile/`?
4. **"Hey Talorys" voice** — in scope for Workstream F v1, or post-MVP?
5. **Linear integration** — should Linear appear as an OpenConnector service (task sync via connector), or is it a standalone integration?

---

*This document is the source of truth for all Talorys build work. Update it when scope changes, phases complete, or open questions are resolved. Don't start a workstream without reading the relevant section.*
