import type { AiAttempt } from "@talorys/shared";
import { AppError } from "../api/errors";
import { attemptOf, chainError } from "./attribution";
import { type CooldownEntry, skippedAttempt } from "./cooldown";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider";

/**
 * Optional memory of recent failures (cooldown.ts): a paused candidate is skipped without a
 * request, a failure may pause it, and a success ends its pause.
 */
export interface CandidateCooldowns {
  active(provider: string, model: string): CooldownEntry | null;
  failed(provider: string, model: string, error: AppError): void;
  succeeded(provider: string, model: string): void;
}

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
    private readonly cooldowns?: CandidateCooldowns,
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

  /**
   * The history budget that fits every candidate (see model-caps.ts): a turn may end on any of
   * them, so the prompt is sized for the smallest window in the chain.
   */
  promptBudget(maxOutputTokens: number): number {
    let budget = Number.POSITIVE_INFINITY;
    for (const c of this.chain) if (c.promptBudget) budget = Math.min(budget, c.promptBudget(maxOutputTokens));
    return budget;
  }

  /**
   * This turn's candidates, in order: paused ones (cooldown) are left out and reported as skipped
   * attempts. When every candidate is paused, all of them are tried anyway.
   */
  private plan(): { order: AIProvider[]; skipped: Map<AIProvider, AiAttempt> } {
    const skipped = new Map<AIProvider, AiAttempt>();
    if (!this.cooldowns) return { order: this.chain, skipped };
    const order: AIProvider[] = [];
    for (const c of this.chain) {
      let entry: CooldownEntry | null = null;
      try {
        entry = this.cooldowns.active(c.id, c.modelId ?? "");
      } catch (error) {
        console.error("cooldown read failed", error);
      }
      if (entry) skipped.set(c, skippedAttempt(c.id, c.modelId ?? "", entry));
      else order.push(c);
    }
    if (order.length === 0) return { order: this.chain, skipped: new Map() };
    return { order, skipped };
  }

  /** The skipped attempts that come before `candidate` in the chain's own order. */
  private skippedBefore(candidate: AIProvider | undefined, skipped: Map<AIProvider, AiAttempt>, taken: Set<AIProvider>): AiAttempt[] {
    const out: AiAttempt[] = [];
    for (const c of this.chain) {
      if (c === candidate) break;
      const a = skipped.get(c);
      if (a && !taken.has(c)) {
        taken.add(c);
        out.push(a);
      }
    }
    return out;
  }

  private noteFailure(candidate: AIProvider, error: unknown): void {
    if (!this.cooldowns || !shouldFallBack(error)) return;
    try {
      this.cooldowns.failed(candidate.id, candidate.modelId ?? "", error as AppError);
    } catch (e) {
      console.error("cooldown write failed", e);
    }
  }

  private noteSuccess(candidate: AIProvider): void {
    try {
      this.cooldowns?.succeeded(candidate.id, candidate.modelId ?? "");
    } catch (e) {
      console.error("cooldown write failed", e);
    }
  }

  async generate(req: GenerateRequest) {
    const attempts: AiAttempt[] = [];
    const { order, skipped } = this.plan();
    const taken = new Set<AIProvider>();
    for (let i = 0; ; i++) {
      const candidate = order[i] as AIProvider;
      const next = order[i + 1];
      attempts.push(...this.skippedBefore(candidate, skipped, taken));
      try {
        const result = await candidate.generate(req);
        this.noteSuccess(candidate);
        return result;
      } catch (error) {
        if (req.signal?.aborted) throw error;
        this.noteFailure(candidate, error);
        attempts.push(attemptOf(error, candidate.id, candidate.modelId ?? ""));
        if (!next || !shouldFallBack(error)) {
          attempts.push(...this.skippedBefore(undefined, skipped, taken));
          throw chainError(error, attempts);
        }
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
    const { order, skipped } = this.plan();
    const taken = new Set<AIProvider>();
    for (let i = 0; i < order.length; i++) {
      const candidate = order[i] as AIProvider;
      const next = order[i + 1];
      attempts.push(...this.skippedBefore(candidate, skipped, taken));
      // Any candidate other than the chosen model is a backup, and is announced as one.
      const isBackup = candidate !== this.chain[0];
      let outcome: { kind: "done"; answered: boolean } | { kind: "failed"; error: AppError };
      try {
        outcome = yield* this.attempt(candidate, req, next !== undefined, isBackup ? attempts : null);
      } catch (error) {
        if (req.signal?.aborted) throw error;
        throw chainError(error, [...attempts, attemptOf(error, candidate.id, candidate.modelId ?? "")]);
      }
      if (outcome.kind === "done") {
        if (outcome.answered) this.noteSuccess(candidate);
        return;
      }
      this.noteFailure(candidate, outcome.error);
      attempts.push(attemptOf(outcome.error, candidate.id, candidate.modelId ?? ""));
      if (!next) {
        attempts.push(...this.skippedBefore(undefined, skipped, taken));
        throw chainError(outcome.error, attempts);
      }
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
  ): AsyncGenerator<AgentEvent, { kind: "done"; answered: boolean } | { kind: "failed"; error: AppError }> {
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
            if (req.signal?.aborted) return { kind: "done", answered: false };
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
          return { kind: "done", answered: !req.signal?.aborted };
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
      // A failure before any content is the candidate's (it may be paused, and the next one runs);
      // the caller ends the turn when there is no next candidate.
      if (committed || req.signal?.aborted || !shouldFallBack(error)) throw error;
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
