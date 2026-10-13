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
`PATCH /api/settings {modelProvider, model, fallback}`. A key is checked with the provider before it is stored,
and only its last four characters are ever returned (`…xbFA`). Each row shows a short Hebrew line for the
common models (others: the provider's description), speed / quality / tools / free tags, and the current one
checked. The backup ("fallback") model takes over when the chosen one fails on quota, configuration or an
outage before it has said a word; in chat a spent quota shows a Hebrew message with a button to Settings → Model.

**Yishai's installation (Oct 13, 2026 ~14:20 IL):** `gemini` / `gemini-3.5-flash`, backup `gemini` /
`gemini-3.5-flash-lite` (Workers AI's daily allowance was spent until 03:00).

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
