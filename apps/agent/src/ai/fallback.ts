import { AppError } from "../api/errors";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider";

/**
 * The chosen model first; when it fails on quota (or is not configured) before it has said a
 * word, the same turn runs again on the backup model. The switch is reported as a `provider`
 * event so the turn can record it. A failure after text has streamed is not retried: the
 * person would see two half answers.
 */
/**
 * How long the chosen model may stay silent before the turn moves to the backup. A free-tier
 * model under load queues requests for minutes (Oct 13, 2026: gemini-3.8-flash answered a
 * one-line Hebrew prompt after 87 s and 203 s, or with 503 "high demand"); a backup that
 * starts in about a second is better than a spinner.
 */
export const FIRST_EVENT_TIMEOUT_MS = 15_000;

export class FallbackProvider implements AIProvider {
  readonly id: AIProvider["id"];
  readonly modelId: string;

  constructor(
    private readonly primary: AIProvider,
    private readonly backup: AIProvider,
    private readonly onFallback?: (error: AppError) => void,
    private readonly firstEventTimeoutMs = FIRST_EVENT_TIMEOUT_MS,
  ) {
    this.id = primary.id;
    this.modelId = primary.modelId ?? "";
  }

  async generate(req: GenerateRequest) {
    try {
      return await this.primary.generate(req);
    } catch (error) {
      if (!shouldFallBack(error)) throw error;
      this.onFallback?.(error as AppError);
      return await this.backup.generate(req);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    let emitted = false;
    let timedOut = false;
    // The primary runs on its own signal so a silent primary can be cut off without ending the turn.
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const it = this.primary.generateWithTools({ ...req, signal: controller.signal })[Symbol.asyncIterator]();
    try {
      for (;;) {
        let next: IteratorResult<AgentEvent>;
        if (emitted) {
          next = await it.next();
        } else {
          let timer: ReturnType<typeof setTimeout> | null = null;
          const silent = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), this.firstEventTimeoutMs);
          });
          const first = await Promise.race([it.next(), silent]);
          if (timer !== null) clearTimeout(timer);
          if (first === "timeout") {
            timedOut = true;
            controller.abort();
            // Let the cut-off call settle; its abort error is expected and not the turn's.
            void it.return?.(undefined)?.catch?.(() => {});
            break;
          }
          next = first;
        }
        if (next.done) return;
        // A usage-only event is bookkeeping, not a word the person has seen.
        if (next.value.type !== "usage") emitted = true;
        yield next.value;
      }
    } catch (error) {
      if (emitted || !shouldFallBack(error) || req.signal?.aborted) throw error;
      this.onFallback?.(error as AppError);
    } finally {
      req.signal?.removeEventListener("abort", onAbort);
    }
    if (req.signal?.aborted) return;
    if (timedOut) {
      this.onFallback?.(
        new AppError("AI_UNAVAILABLE", `No answer from ${this.primary.modelId ?? this.primary.id} within ${Math.round(this.firstEventTimeoutMs / 1000)} s; switched to the backup model.`, {
          provider: this.primary.id,
        }),
      );
    }
    yield { type: "provider", provider: this.backup.id, model: this.backup.modelId ?? "" };
    yield* this.backup.generateWithTools(req);
  }
}

export function shouldFallBack(error: unknown): boolean {
  return error instanceof AppError && (error.code === "AI_QUOTA_EXHAUSTED" || error.code === "NOT_CONFIGURED" || error.code === "AI_UNAVAILABLE");
}
