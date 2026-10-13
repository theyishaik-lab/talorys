import { AppError } from "../api/errors";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider";

/**
 * The chosen model first; when it fails on quota (or is not configured) before it has said a
 * word, the same turn runs again on the backup model. The switch is reported as a `provider`
 * event so the turn can record it. A failure after text has streamed is not retried: the
 * person would see two half answers.
 */
export class FallbackProvider implements AIProvider {
  readonly id: AIProvider["id"];
  readonly modelId: string;

  constructor(
    private readonly primary: AIProvider,
    private readonly backup: AIProvider,
    private readonly onFallback?: (error: AppError) => void,
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
    try {
      for await (const event of this.primary.generateWithTools(req)) {
        emitted = true;
        yield event;
      }
      return;
    } catch (error) {
      if (emitted || !shouldFallBack(error) || req.signal?.aborted) throw error;
      this.onFallback?.(error as AppError);
    }
    yield { type: "provider", provider: this.backup.id, model: this.backup.modelId ?? "" };
    yield* this.backup.generateWithTools(req);
  }
}

export function shouldFallBack(error: unknown): boolean {
  return error instanceof AppError && (error.code === "AI_QUOTA_EXHAUSTED" || error.code === "NOT_CONFIGURED" || error.code === "AI_UNAVAILABLE");
}
