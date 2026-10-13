import type { AiAttempt } from "@talorys/shared";
import { AppError } from "../api/errors";
import { attemptOf, chainError } from "./attribution";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider";

/**
 * How long a model may stay silent before the turn moves on to the next one in the chain. A
 * free-tier model under load queues requests for minutes (Oct 13, 2026: gemini-3.8-flash answered
 * a one-line Hebrew prompt after 87 s and 203 s, or with 503 "high demand"); a backup that starts
 * in about a second is better than a spinner.
 */
export const FIRST_EVENT_TIMEOUT_MS = 15_000;

/**
 * The chosen model first, then each backup in order. A candidate is abandoned — and the turn runs
 * again on the next one — only while it has produced nothing the person or the tools could have
 * seen: it failed on quota / availability / configuration, or it stayed silent past the watchdog.
 * Once any text or tool event has streamed, the turn is committed to that model and a later
 * failure is the turn's error (a retry would show two half answers or repeat a tool effect).
 *
 * Usage and provider events are bookkeeping, not content: they never commit the turn. The switch
 * to a backup is reported as a `provider` event, yielded only once that backup has produced its
 * first real event, so a backup that also fails leaves no false "answered by" record.
 *
 * The watchdog applies to every candidate except the last: the last one has nothing to fall back
 * to, so it is allowed to answer slowly rather than not at all.
 */
export class FallbackProvider implements AIProvider {
  readonly id: AIProvider["id"];
  readonly modelId: string;
  private readonly chain: AIProvider[];

  constructor(
    chain: AIProvider[],
    private readonly onFallback?: (error: AppError, from: AIProvider, to: AIProvider) => void,
    private readonly firstEventTimeoutMs = FIRST_EVENT_TIMEOUT_MS,
  ) {
    if (chain.length === 0) throw new Error("FallbackProvider needs at least one provider");
    this.chain = chain;
    const primary = chain[0] as AIProvider;
    this.id = primary.id;
    this.modelId = primary.modelId ?? "";
  }

  /** The providers in the order they are tried. */
  get candidates(): readonly AIProvider[] {
    return this.chain;
  }

  async generate(req: GenerateRequest) {
    const attempts: AiAttempt[] = [];
    for (let i = 0; ; i++) {
      const candidate = this.chain[i] as AIProvider;
      const next = this.chain[i + 1];
      try {
        return await candidate.generate(req);
      } catch (error) {
        if (req.signal?.aborted) throw error;
        attempts.push(attemptOf(error, candidate.id, candidate.modelId ?? ""));
        if (!next || !shouldFallBack(error)) throw chainError(error, attempts);
        this.onFallback?.(error as AppError, candidate, next);
      }
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  /**
   * Every failure that ends the turn is thrown as one error naming each model tried and why
   * (`details.attempts`, see attribution.ts); a backup that answers is announced with the
   * failures before it.
   */
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const attempts: AiAttempt[] = [];
    for (let i = 0; i < this.chain.length; i++) {
      const candidate = this.chain[i] as AIProvider;
      const next = this.chain[i + 1];
      let outcome: { kind: "done" } | { kind: "failed"; error: AppError };
      try {
        outcome = yield* this.attempt(candidate, req, next !== undefined, i > 0 ? attempts : null);
      } catch (error) {
        if (req.signal?.aborted) throw error;
        throw chainError(error, [...attempts, attemptOf(error, candidate.id, candidate.modelId ?? "")]);
      }
      if (outcome.kind === "done") return;
      attempts.push(attemptOf(outcome.error, candidate.id, candidate.modelId ?? ""));
      if (!next) throw chainError(outcome.error, attempts);
      // Nothing useful was emitted and a next candidate exists.
      this.onFallback?.(outcome.error, candidate, next);
    }
  }

  /**
   * Runs one candidate. Returns `done` when it finished or the turn was cancelled, `failed` when it
   * may be replaced by the next candidate; anything else (a failure after content, a failure that
   * is not a fallback reason, any failure of the last candidate) is thrown as the turn's error.
   */
  private async *attempt(
    candidate: AIProvider,
    req: ToolRequest,
    hasNext: boolean,
    /** The failures before this candidate when it is a backup (it is then announced), else null. */
    before: AiAttempt[] | null,
  ): AsyncGenerator<AgentEvent, { kind: "done" } | { kind: "failed"; error: AppError }> {
    const watchdogMs = hasNext ? this.firstEventTimeoutMs : null;
    let committed = false;
    // Bookkeeping events seen before the first real one: forwarded once the candidate commits,
    // and usage forwarded even if it fails (the tokens were spent).
    const pending: AgentEvent[] = before ? [{ type: "provider", provider: candidate.id, model: candidate.modelId ?? "", attempts: [...before] }] : [];
    // Each candidate runs on its own signal so a silent one can be cut off without ending the turn.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (req.signal?.aborted) controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    let it: AsyncIterator<AgentEvent> | null = null;
    try {
      it = candidate.generateWithTools({ ...req, signal: controller.signal })[Symbol.asyncIterator]();
      for (;;) {
        let next: IteratorResult<AgentEvent>;
        if (committed || watchdogMs === null) {
          next = await it.next();
        } else {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const silent = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), watchdogMs);
          });
          const raced = await Promise.race([it.next(), silent]);
          if (timer !== null) clearTimeout(timer);
          if (raced === "timeout") {
            controller.abort();
            // Let the cut-off call settle; its abort error is expected and not the turn's.
            const cut = it;
            it = null;
            void Promise.resolve()
              .then(() => cut.return?.(undefined))
              .catch(() => {});
            if (req.signal?.aborted) return { kind: "done" };
            return {
              kind: "failed",
              error: new AppError("AI_UNAVAILABLE", `No answer from ${candidate.modelId ?? candidate.id} within ${Math.round(watchdogMs / 1000)} s; switched to the next model.`, {
                provider: candidate.id,
                model: candidate.modelId ?? "",
                reason: "timeout",
                timeout_s: Math.round(watchdogMs / 1000),
              }),
            };
          }
          next = raced;
        }
        if (next.done) {
          // A candidate that ends having said nothing still answered (an empty answer is the
          // turn's to judge); flush its bookkeeping.
          for (const e of pending) yield e;
          return { kind: "done" };
        }
        const event = next.value;
        if (committed) {
          yield event;
          continue;
        }
        if (event.type === "usage") {
          yield event;
          continue;
        }
        if (event.type === "provider") {
          // A nested chain's own switch report: metadata, never a commitment.
          pending.length = 0;
          pending.push(event);
          continue;
        }
        committed = true;
        for (const e of pending) yield e;
        pending.length = 0;
        yield event;
      }
    } catch (error) {
      if (committed || req.signal?.aborted || !hasNext || !shouldFallBack(error)) throw error;
      return { kind: "failed", error: error as AppError };
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * The (provider, model) pairs a turn tries, in order: the chosen model, the selected backup, then
 * the extra backups — skipping duplicates. Pure, so the order is testable without a Worker.
 */
export function fallbackOrder<T extends { provider: string; model: string }>(primary: T, fallback: { enabled: boolean; provider: string; model: string; chain?: readonly T[] }): T[] {
  const out: T[] = [primary];
  if (!fallback.enabled) return out;
  const seen = new Set([key(primary)]);
  const candidates = [{ provider: fallback.provider, model: fallback.model } as T, ...(fallback.chain ?? [])];
  for (const c of candidates) {
    const k = key(c);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

function key(ref: { provider: string; model: string }): string {
  return `${ref.provider}\u0000${ref.model}`;
}

export function shouldFallBack(error: unknown): boolean {
  return error instanceof AppError && (error.code === "AI_QUOTA_EXHAUSTED" || error.code === "NOT_CONFIGURED" || error.code === "AI_UNAVAILABLE");
}
