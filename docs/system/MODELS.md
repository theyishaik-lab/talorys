# Chat models: providers, the picker, latency

## Providers and Settings → Model (agent 0.1.8, Oct 13, 2026)

Three providers, picked per installation in **Settings → Model** (`apps/web/src/components/ModelPicker.tsx`),
stored server-side in the agent's settings (`modelProvider`, `model`, `fallback`) and used from the next turn:

| Provider | Catalog | Key |
|---|---|---|
| Cloudflare Workers AI | live from the account's Workers AI models API, filtered to text models with function calling | none (the `AI` binding); free plan 10,000 neurons/day |
| Google Gemini | live from `v1beta/models` with the stored key (static list before a key exists); 2.x is hidden — new keys get 404 "no longer available to new users" | Gemini API key from aistudio.google.com, stored encrypted in the agent DB |
| OpenRouter | live public models list, `:free` models | optional OpenRouter key, stored encrypted |

API: `GET /api/ai/models[?refresh=1]`, `PUT|DELETE /api/ai/keys/:provider`, `POST /api/ai/keys/:provider/test`,
`PATCH /api/settings {modelProvider, model, fallback}` (`fallback.chain`: see "Fallback chain" below). A key is checked with the provider before it is stored,
and only its last four characters are ever returned (`…xbFA`). Each row shows a short Hebrew line for the
common models (others: the provider's description), speed / quality / tools / free tags, and the current one
checked. The backup ("fallback") model takes over when the chosen one fails on quota, configuration or an
outage before it has said a word; in chat a spent quota shows a Hebrew message with a button to Settings → Model.

**Yishai's installation (Oct 13, 2026 ~23:30 IL, agent 0.1.14-max):** best-first cascade over every free
model his keys can call — see "Best-first cascade, cooldowns and limits" below for the order and why.

## Latency (Oct 13, 2026)

A one-line Hebrew question took **87 s** on `gemini-3.8-flash`. Measured directly against the Gemini API
with the same key (short Hebrew prompt, no tools): `gemini-3.8-flash` answered 503 "high demand" with
default settings and **203 s** to the first token with thinking "low" (324 thought tokens — the time was
queueing, not thinking); `gemini-3.7-flash` 145 s; `gemini-3.5-flash` low **3.2 s**;
`gemini-3.5-flash-lite` minimal **0.7 s**; `gemini-3.1-flash-lite` 5.2 s. The newest Flash models are
overloaded on the free tier and Google queues free requests. Nothing set a thinking level either, so
Gemini 3 thought at its default ("high").

Fixes (`bc77518`):
- `geminiThinking()` (`apps/agent/src/ai/gemini.ts`): lowest level each model accepts — "minimal" on lite
  models, "low" otherwise (3.8 rejects "minimal"); 2.x: `thinkingBudget` 0 (Pro 128).
- `FallbackProvider` first-word watchdog (`apps/agent/src/ai/fallback.ts`, `FIRST_EVENT_TIMEOUT_MS` = 15 s):
  a chosen model that has emitted nothing in 15 s is cancelled and the turn runs on the backup (logged as
  `ai.fallback` in activity).
- His model moved to `gemini-3.5-flash`, backup `gemini-3.5-flash-lite`.

On his live agent afterwards: first word **1.0 s** for a simple Hebrew question, **2.1 s** for one that
used a tool (tool chip at 1.05 s).

## Fallback chain (agent 0.1.12-chain, Oct 13, 2026)

Oct 13 ~16:50 IL every free Gemini model answered 503 "high demand" at once and Workers AI was spent, so a
single backup was not enough. `settings.fallback` gained an additive `chain`:

```json
{ "enabled": true, "provider": "gemini", "model": "gemini-3.5-flash",
  "chain": [ { "provider": "openrouter", "model": "<vendor>/<model>:free" } ] }
```

- Order tried: the chosen model → `fallback.provider/model` (the selected backup, what the picker has always
  written) → each `chain` entry. Duplicate (provider, model) pairs are tried once; a provider with no binding
  is skipped; `enabled: false` turns the whole chain off. At most 16 chain entries (`MAX_FALLBACK_CHAIN`; 4 before 0.1.14-max).
- Backwards compatible: settings stored before `chain` read as `chain: []`; a `PATCH /api/settings` whose
  `fallback` has no `chain` (the current web and mobile pickers) keeps the stored chain; `chain: []` clears
  it. `GET /api/ai/models` returns the whole `fallback` including `chain`.
- `FallbackProvider([a, b, c, …])` (`apps/agent/src/ai/fallback.ts`): a candidate is replaced only while it
  has produced no text and no tool event — on `AI_QUOTA_EXHAUSTED` / `AI_UNAVAILABLE` / `NOT_CONFIGURED`, or
  after 15 s of silence (cancelled through its own abort signal). The watchdog runs on every candidate except
  the last (nothing behind it). After any text or tool event the turn is committed: a later failure is the
  turn's error, never a retry (no double answers, no repeated tool effects). `usage` and nested `provider`
  events never commit. The `provider` event for a backup is yielded only once that backup produced real
  content, so the activity log names the model that actually answered; each hop is logged as `ai.fallback`
  "from → to: reason". A cancelled turn stops the chain.
- Tests: `apps/agent/test/fallback-chain.test.ts` (503→503→ok, timeout per candidate, no retry after text /
  tool, abort, non-fallback errors, slow last candidate, `generate()`, ordering/dedupe) and the settings API
  test in `models.test.ts`.

## Best-first cascade, cooldowns and limits (agent 0.1.14-max, Oct 13, 2026)

Yishai, Oct 13 22:27: "the maximum that's technically possible — start from the best model, and when its
tokens run out, step down through every option; don't limit anything we don't have to."

### Which free models his keys can actually call (real requests, Oct 13 ~22:35–22:55 IL)

Hebrew one-liner + a `list_tasks` tool call per model, his own keys.

| Model | Result |
|---|---|
| `gemini-4-argon`, `gemini-pro-latest`, `gemini-3.1-pro-preview(-customtools)` | **429 "limit: 0"** — no free-tier quota at all for Pro models on his key |
| `gemini-2.5-pro`, `gemini-2.5-flash(-lite)` | 404 "no longer available to new users" |
| `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-flash-latest` | 503 "high demand" at test time (3.8 answered earlier the same day after 68–87 s, 3.7 after 145 s) |
| `gemini-3.6-flash`, `gemini-3.5-flash` | tool call OK (2.0 s / 1.4 s); also 503 on a second try minutes later — flaky under load |
| `gemini-3-flash-preview` | Hebrew 2.2–2.8 s, tool call 1.0 s |
| `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-flash-lite-latest` | Hebrew + tools OK (0.6–6 s) |
| `gemma-4-26b-a4b-it` (Gemini API) | Hebrew OK in 11 s (thinks ~450 tokens), tool call 2.7 s; **rejects `thinkingConfig`** (400) → `geminiThinking()` sends none for Gemma |
| `gemma-4-31b-it` (Gemini API) | 500 "Internal error" twice (once after 62 s) — rejected |
| OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` | Hebrew 2.4 s (fluent), tool call 1.3 s |
| OpenRouter `nvidia/nemotron-3-super-120b-a12b:free` | verified earlier Oct 13 (Hebrew 3 s, tool 1.1 s) |
| OpenRouter `poolside/laguna-s-2.1:free` | tool call OK, Hebrew request 429 "rate-limited upstream" — not included (Hebrew unverified; a coding model) |
| OpenRouter `google/gemma-4-31b-it:free` | 429 "rate-limited upstream" (also earlier) — rejected |
| OpenRouter `dots-studio/dots-3-note-preview:free` | 400 from its provider on a tool request — rejected |
| OpenRouter `thinkingmachines/inkling(-small):free` | 403 "only available on agentic harnesses" — rejected |
| Workers AI | daily 10,000 neurons spent (4006) at test time; `@cf/google/gemma-4-26b-a4b-it` 5/6 and `@cf/openai/gpt-oss-120b` 2/2 in the Oct 13 bench (below) |

`*-latest` aliases are left out of the chain (they point at a model already in it).

### The order (live since Oct 13 ~23:10 IL)

Nemotron 3 Ultra first: as good in Hebrew as the Gemini Flash models in the test and it answers now,
while Gemini 3.8/3.7 are mostly "high demand". OpenRouter's 50 free requests/day are shared by both
Nemotrons; once spent, both are paused until 00:00 UTC and the Gemini rungs take over.

1. `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` (primary)
2. `openrouter/nvidia/nemotron-3-super-120b-a12b:free` (selected backup)
3. `gemini/gemini-3.8-flash` → 4. `gemini-3-flash-preview` → 5. `gemini-3.7-flash` → 6. `gemini-3.6-flash` → 7. `gemini-3.5-flash`
8. (Groq slot: `openai-compatible/groq/…` once a key exists)
9. `gemini-3.5-flash-lite` → 10. `gemini-3.1-flash-lite` → 11. `gemini/gemma-4-26b-a4b-it`
12. `workers-ai/@cf/google/gemma-4-26b-a4b-it` → 13. `workers-ai/@cf/openai/gpt-oss-120b`
14. `openai-compatible/ovh/gpt-oss-120b` (through the live agent: tool round-trip 2.7 s; after a Gemini 503 the
    chain reached it and a second turn skipped the paused Gemini — answer in 6.4 s)

`ovh/Qwen3.5-397B-A17B` answered from the box (Hebrew 4.6 s) but through the agent (full system prompt +
tools) it ended in a 520 after 54 s — left out.

### Cooldowns — a spent model is skipped, not asked on every message (`apps/agent/src/ai/cooldown.ts`)

- `classifyAiError` now also records the provider's own hints in `details`: `retry_after_s` (Retry-After,
  X-RateLimit-Reset, Gemini's "Please retry in 4h26m27s" / `retryDelay`), `quota_window` ("day" for
  Gemini `…PerDay…`, OpenRouter `free-models-per-day`, Workers AI 4006; "minute" otherwise) and `scope`
  ("provider" for OpenRouter's free allowance and Workers AI neurons, which are the account's).
- `FallbackProvider` takes optional cooldown hooks. A failure before any content pauses that model:
  daily quota → until the provider's reset hint, else next 00:00 UTC (10 min … 24 h); per-minute limit →
  the hint or 60 s; 503 / unknown error → 1 min doubling per consecutive failure to 30 min; 15 s silence →
  5 min doubling to 30 min; 404 model → 6 h; rejected key 1 h; no key 10 min. A success ends the pause;
  a new key (`PUT /api/ai/keys/:p`) ends that provider's pauses.
- A paused model is not called; it appears in the turn's `attempts` as `{…, skipped: true, until}` and
  reads "Gemini 3.8 Flash (Google): מכסה (בהשהיה)". If **every** model is paused, all are tried anyway.
  A backup is announced (`model` event, "ענה: …") whenever the answering model is not the chosen one,
  including when the chosen one was skipped.
- Stored in `tal_settings` under `ai_cooldowns` (no migration). `GET /api/ai/cooldowns` lists them (also
  in `GET /api/ai/models` as `cooldowns`); `DELETE /api/ai/cooldowns` clears them. Each pause is logged
  as activity `ai.cooldown`.

### OpenAI-compatible endpoints (agent 0.1.15-endpoints)

A fourth provider, `openai-compatible`, so any free OpenAI-compatible source joins the chain without
new code. Model ids are `<endpoint id>/<model>` (`ovh/gpt-oss-120b`, `groq/openai/gpt-oss-120b`).

- `GET /api/ai/endpoints` → `{endpoints:[{id,name,baseURL,key:{set,hint}}], presets}`;
  `PUT /api/ai/endpoints/:id {name?, baseURL?, key?}` (a preset id needs no body; `key` is stored
  encrypted like the provider keys under `endpoint:<id>`, `key: null` removes it); `DELETE` removes the
  endpoint and its key. https only. Presets (`apps/agent/src/ai/openai-compatible.ts`): `ovh` (no key),
  `groq`, `cerebras`, `mistral`, `github`, `nvidia`.
- A chain entry on a missing endpoint fails `NOT_CONFIGURED` and the chain moves on. The error and
  "ענה:" lines name the endpoint: "GPT OSS 120B (OVH)".
- Adding Groq later: `PUT /api/ai/endpoints/groq {"key":"gsk_…"}`, then add
  `{"provider":"openai-compatible","model":"groq/openai/gpt-oss-120b"}` (and/or `groq/qwen/qwen3.8-27b`)
  to `fallback.chain` after the Gemini Flash models.
- OVH AI Endpoints, anonymous (checked Oct 13, 2026 from the box): `gpt-oss-120b` tool call 2.1 s;
  `Qwen3.5-397B-A17B` Hebrew 4.6 s, tool call 1.3 s (but 520 after 54 s through the agent). Limit **2 requests/minute per IP and per model**
  (`RateLimit-Limit: 2`, `RateLimit-Reset` seconds — read by `quotaHints`), so they are the last rungs.
  From a Worker the IP is Cloudflare's, possibly shared; a 429 just pauses that model for the reset.

### Limits (`LIMIT_CEILINGS` in packages/shared/src/constants.ts)

| Limit | Old ceiling | New ceiling = his live value | What actually bounds it |
|---|---|---|---|
| maxOutputTokens | 4,096 | 262,144 | clamped per model (`model-caps.ts`): Gemini 65,536, Gemma 32,768, Nemotron 65,536, Workers AI gemma 32,768 / gpt-oss 32,000 |
| maxContextTokens | 32,000 | 1,048,576 | history is cut to the smallest window in the chain: (context − output) × 0.5 (`estimateTokens` is chars/4; Hebrew is ~2× that). With gpt-oss-120b (128k) last in his chain that is 48,000 estimated tokens ≈ 190k characters of history |
| maxToolCalls | 20 | 500 | `SubrequestGuard`: Workers Free allows **50 subrequests per invocation**; model steps + tool calls stop at 38 (12 kept for fallback hops, keys, push), then the model must answer. `TALORYS_SUBREQUEST_LIMIT` (Worker var) raises it on a Paid plan (10,000) |
| maxAgentIterations | 10 | 200 | same guard |
| maxScheduledAiRunsPerDay | 48 | 1,440 | one AI routine per minute; scheduled runs keep their own per-run caps (4 tools, 3 steps, 600 output tokens) |
| maxAiRequestsPerDay | 2,000 | 100,000 | Workers Free's 100,000 requests/day; in practice the providers' free quotas end first |

Guards kept: the subrequest guard, per-tool caps and duplicate-call detection (`ToolExecutor`), the
leak guard's stuck-loop stop, the scheduled-run caps, and the daily request counter. Nothing can cost
money: no card on Cloudflare (Workers AI refuses past 10k neurons), $0 OpenRouter credits, Gemini free
tier (no billing account).

## Chain editor and quota view (agent 0.1.16-chain, Oct 13, 2026)

Yishai, Oct 13 23:21: a Settings screen to order the model chain and see how much quota each model has
left. Web: Settings → AI → "שרשרת מודלים" (top of the Model section, `apps/web/src/components/ChainEditor.tsx`).
Mobile: Settings → Model → "שרשרת מודלים" (`apps/mobile/src/app/settings/chain.tsx`, from v0.1.3).

- **One list.** The chosen model, the selected backup and `fallback.chain` are shown as one ordered list
  (`chainFromSettings` in `packages/shared/src/chain.ts`, duplicates once). Saving writes it back with
  `settingsPatchForChain`: entry 1 → `modelProvider/model`, entry 2 → `fallback.provider/model`, the rest
  → `fallback.chain` (one `PATCH /api/settings`). Up to 18 entries (chosen + backup + `MAX_FALLBACK_CHAIN`).
  Edits are a local draft until "שמור סדר"; nothing is written while reordering.
- **Edit:** drag the grip (web; pointer events, works with touch) or the ↑/↓ arrows (web and mobile), the
  trash icon removes, "הוסף מודל" lists the models per provider (the catalog for Gemini / OpenRouter /
  Workers AI, `GET /api/ai/endpoints/:id/models` for an OpenAI-compatible endpoint — speech, TTS, guard and
  embedding models filtered out) or takes a typed model id, "הוסף נקודת קצה" registers a new endpoint
  (name → id via `endpointIdFromName`, base URL, optional key → `PUT /api/ai/endpoints/:id`) and appends
  its model. The switch on top is `fallback.enabled`.
- **Status, `GET /api/ai/chain`** (read-only, `apps/agent/src/ai/chain-status.ts`) → `{enabled, checked_at,
  entries:[{position, provider, model, label, provider_label, state, until, reason, error, quota}]}`:
  - `state`: `available` · `paused` (a cooldown after overload / per-minute limit / silence; `until` =
    when it is tried again) · `exhausted` (a DAILY quota pause — cooldowns now record `window: "day" |
    "minute"` — or the provider's own counter at 0; `until` = the reset) · `not_configured` (no key, endpoint
    gone, no Workers AI binding, or a rejected key).
  - `quota`: OpenRouter's account-wide free allowance from `GET https://openrouter.ai/api/v1/key` →
    `free_model_daily_requests {used, limit, remaining}` (asked on every status read; costs nothing; shared by
    all `:free` models, resets 00:00 UTC). For OpenAI-compatible endpoints, the **rate-limit headers of the last
    real response** (`apps/agent/src/ai/quota.ts`: `observingFetch` wraps the endpoint's fetch;
    Groq `x-ratelimit-{limit,remaining,reset}-{requests,tokens}` = requests per **day**, tokens per minute;
    OVH `RateLimit-*` per minute), kept in `tal_settings` under `ai_quota_seen` for 48 h — no extra
    requests. A counter whose reset time has passed reads as full. Gemini and Workers AI report nothing
    usable → `quota: null` → the screen says "מכסה: לא ידוע".
- The screen polls every 60 s; "נסה שוב מודלים בהשהיה" is `DELETE /api/ai/cooldowns`.
- Tests: `apps/agent/test/chain-status.test.ts` (header parsing, snapshot store, states, route + endpoint
  models), `apps/web/test/chain-view.test.ts`, `apps/mobile/tests/chain.test.ts`.

# Workers AI model benchmark (free plan)

Benchmarked Oct 13, 2026 with `apps/agent/bench/models.bench.test.ts` (the real runner, system
prompt, Talorys + OpenConnector tools and Workers AI provider; live Workers AI REST API and the live
OpenConnector; 6 Hebrew prompts: last 3 mails, calendar this week, Drive files, GitHub repos, an email
draft that needs approval, a plain Hebrew question).

| Model | Result | Neurons / request* | Notes |
|---|---|---|---|
| `@cf/google/gemma-4-26b-a4b-it` | 5/6 | ~165 (~60 chats/day) | **In use since Oct 13, 2026.** Good Hebrew, no leaked tool text, 2–20 s |
| `@cf/openai/gpt-oss-120b` | 2/2 tested | ~430 (~20/day) | Best answers, too costly for the free allowance |
| `@cf/zai-org/glm-4.7-flash` | 2/6 | ~75 | Previous default: misreads connected apps, leaks `<tool_call>` text |
| `@cf/qwen/qwen3-30b-a3b-fp8`, `@cf/meta/llama-4-scout-17b-16e-instruct` | fail | – | Every streamed token arrives twice through workers-ai-provider 4.0; tool args break |
| `@cf/openai/gpt-oss-20b` | fail | – | Empty answers |
| `@cf/ibm-granite/granite-4.0-h-micro` | fail | ~10 | Wrong tools, malformed arguments |
| `@cf/zai-org/glm-5.3-flash`, `@cf/deepseek-ai/deepseek-v4-flash-0731` | n/a | – | "not available on the Workers Free plan" |

\* Price list × measured tokens; one request is often 3–5 model calls of ~5k input tokens each.
The free plan has 10,000 neurons/day, reset at 00:00 UTC.

The model is a per-installation setting (Settings → Workers AI model, or `PATCH /api/settings
{"model": "..."}`), not code. Roll back by setting `@cf/zai-org/glm-4.7-flash`.

## Leak guard

`apps/agent/src/ai/leak-guard.ts` (used by `CloudflareWorkersAIProvider.generateWithTools`) hides
tool-call markup a model writes as text (`<tool_call>`, `<function=`, `[TOOL_CALLS]`, …), turns it into
a real tool call when it names a known tool and the step/tool/daily budgets allow (up to 3 per turn),
drops a preamble repeated on every step or a line repeated back to back, and ends a stuck loop with a
short apology in the owner's language. Tests: `apps/agent/test/leak-guard.test.ts`.

## Re-running the bench

Costs real neurons from the same daily allowance the owner uses (a full 6-prompt run is ~450 for
glm-4.7-flash, ~1,000 for gemma-4, ~2,600 for gpt-oss-120b).

```
cd apps/agent
BENCH_CF_ACCOUNT=<account id> BENCH_CF_TOKEN=<token with Workers AI> \
BENCH_OC_URL=https://open-connector.yishai-kaminsky.workers.dev BENCH_OC_TOKEN=<runtime token> \
BENCH_MODELS=@cf/google/gemma-4-26b-a4b-it BENCH_PROMPTS=0,1,2 \
npx vitest run --config vitest.bench.config.ts    # prints one BENCHROW json line per prompt
```


## Error attribution (agent 0.1.13-attrib, Oct 13, 2026)

Yishai asked that every model error say which model and provider it came from. All fields are
additive and optional, so older clients keep working (they ignore unknown fields and events).

Types live in `packages/shared/src/attribution.ts` (`AiAttempt`, `AiAttribution`, `modelLabel`,
`formatAttempts`).

- **`error` stream event** now also carries `provider`, `model` (the last model tried), `status`
  (provider HTTP status or null), `reason`, and `attempts` (every model tried, in order). `details`
  keeps `provider`/`model` too, which older web builds read.
- **New `model` stream event**: `{type:"model", provider, model, fallback:true, attempts}`. It's sent
  before the first text when a backup answers instead of the chosen model.
- **Assistant messages** have `ai: {provider, model, fallback, attempts}`. It is saved in
  `tal_messages.ai` (migration 9) and returned by `/api/conversations/:id` and the `done` event.
  Older messages have no `ai`.
- `AiAttempt` = `{provider, model, code, reason, status?, timeout_s?, error}`, where `reason` is one of
  `overloaded | quota | timeout | not_configured | bad_key | no_model | error`.
- **Reason words** (`attemptReason`): עומס 503 · מכסה · לא הגיב 15 ש׳ · לא מוגדר · מפתח שגוי ·
  מודל לא זמין · שגיאה (English: overloaded 503 · quota · no answer in 15 s …).
- **What the user sees**:
  - Web: the error bubble shows a localized headline, then a small line such as
    "Gemini 3.8 Flash (Google): עומס 503 · Llama 3.3 70B (OpenRouter): מכסה".
  - Web: under a reply written by a backup, a quiet note: "ענה: Nemotron 3 Super 120B A12B (OpenRouter)".
  - Mobile renders the same (`apps/mobile/src/lib/errors.ts`, `MessageRow.tsx`) from the next APK on.
