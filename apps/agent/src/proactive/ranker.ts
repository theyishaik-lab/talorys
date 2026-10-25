import type { AIProvider } from "../ai/provider";
import type { UsageService } from "../services/usage";
import type { Limits } from "@talorys/shared";

export interface RankerCandidate {
  kind: string;
  title: string;
  body: string;
  signalHash: string;
  score: number;
  /** Optional structured metadata passed to the ranker for action proposals. */
  meta?: Record<string, unknown>;
}

export interface EnrichedCandidate extends RankerCandidate {
  proposedTool?: string | null;
  proposedInput?: string | null;
}

interface RankerResult {
  signalHash: string;
  score: number;
  proposed_tool: string | null;
  proposed_input: Record<string, unknown> | null;
}

const RANKER_PROMPT_PREFIX = `You are a proactive task coach. Given these task signals (JSON), rank them by urgency and optionally suggest a one-tap action per task.

Return ONLY a JSON array (one object per task, order = decreasing priority):
[{"signalHash":"...","score":N,"proposed_tool":null,"proposed_input":null}]

Available tools:
- complete_task: {"id":"<task_id>"}  — only for clearly overdue, simple tasks
- update_task: {"id":"<task_id>","due_at":"<YYYY-MM-DD>"}  — only to reschedule

Signals:
`;

/**
 * Phase 2 ranker: one budgeted AI call that re-ranks candidates and optionally attaches
 * tool proposals to suggestions. Falls back to the original ordering if AI is unavailable
 * or parsing fails.
 */
export async function rankCandidates(
  candidates: RankerCandidate[],
  provider: AIProvider | null,
  usage: UsageService,
  limits: Limits,
): Promise<EnrichedCandidate[]> {
  if (!provider || !usage.canRunScheduledAi(limits) || candidates.length === 0) {
    return candidates;
  }

  const prompt = RANKER_PROMPT_PREFIX + JSON.stringify(
    candidates.map((c) => ({
      signalHash: c.signalHash,
      title: c.title,
      score: c.score,
      meta: c.meta,
    })),
    null,
    0,
  );

  let rawText = "";
  try {
    usage.increment({ ai_requests: 1, scheduled_ai_runs: 1 });
    const result = await provider.generate({
      system: "You are a JSON-only response assistant. Return only valid JSON, no markdown.",
      messages: [{ role: "user", content: prompt }],
      maxOutputTokens: 800,
      temperature: 0.1,
    });
    rawText = result.text;
    usage.increment({ input_tokens: result.usage.inputTokens, output_tokens: result.usage.outputTokens });
  } catch {
    usage.increment({ ai_errors: 1 });
    return candidates;
  }

  let parsed: RankerResult[] | null = null;
  try {
    const clean = rawText.replace(/^```json\s*/i, "").replace(/\s*```$/, "").trim();
    const arr = JSON.parse(clean) as unknown;
    if (Array.isArray(arr)) {
      parsed = arr.filter(
        (r): r is RankerResult =>
          typeof r === "object" &&
          r !== null &&
          "signalHash" in r &&
          "score" in r,
      );
    }
  } catch {
    return candidates;
  }

  if (!parsed || parsed.length === 0) return candidates;

  const resultMap = new Map(parsed.map((r) => [r.signalHash, r]));

  const enriched: EnrichedCandidate[] = candidates.map((c) => {
    const r = resultMap.get(c.signalHash);
    if (!r) return c;
    return {
      ...c,
      score: typeof r.score === "number" ? r.score : c.score,
      proposedTool: r.proposed_tool ?? null,
      proposedInput: r.proposed_input ? JSON.stringify(r.proposed_input) : null,
    };
  });

  // Re-sort by the AI-assigned scores.
  enriched.sort((a, b) => b.score - a.score);
  return enriched;
}
