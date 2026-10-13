# Chat model choice (Workers AI, free plan)

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
