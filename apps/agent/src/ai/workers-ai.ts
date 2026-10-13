import { generateText, type LanguageModel, streamText, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { AiProviderId } from "@talorys/shared";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "./provider";
import { classifyAiError } from "./provider";
import { gracefulStopText, LEAK_MARKERS, LeakGuard, parseLeakedToolCalls } from "./leak-guard";
import { type ModelCaps, modelCaps, outputFor, promptBudgetFor } from "./model-caps";

/**
 * Any chat model behind the AI SDK (Workers AI, Gemini, OpenRouter) with Talorys's turn loop:
 * streaming, the SDK's tool loop, and the `LeakGuard` that keeps leaked tool markup out of the
 * answer. The model is resolved lazily so a provider whose API key lives encrypted in the
 * database can be constructed synchronously.
 */
export class AiSdkProvider implements AIProvider {
  constructor(
    readonly id: AiProviderId,
    readonly modelId: string,
    private readonly resolveModel: () => Promise<LanguageModel>,
    /** Per-provider request options (e.g. Gemini's thinking level), passed to every call. */
    private readonly providerOptions?: Record<string, Record<string, unknown>>,
  ) {}

  private model(): Promise<LanguageModel> {
    return this.resolveModel();
  }

  /** This model's window and output maximum (model-caps.ts); requests are clamped to them. */
  get caps(): ModelCaps {
    return modelCaps(this.id, this.modelId);
  }

  promptBudget(maxOutputTokens: number): number {
    return promptBudgetFor(this.caps, maxOutputTokens);
  }

  async generate(req: GenerateRequest) {
    try {
      const result = await generateText({
        model: await this.model(),
        instructions: req.system,
        messages: req.messages,
        maxOutputTokens: outputFor(this.caps, req.maxOutputTokens),
        temperature: req.temperature,
        abortSignal: req.signal,
        // Retries would be model calls the daily budget cannot see; the UI offers Retry instead.
        maxRetries: 0,
        ...(this.providerOptions ? { providerOptions: this.providerOptions as never } : {}),
      });
      return {
        text: result.text,
        usage: { inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 },
      };
    } catch (error) {
      throw classifyAiError(error, this.id, this.modelId);
    }
  }

  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }

  /**
   * One owner turn: streamText's own tool loop, wrapped in a `LeakGuard`. When the model writes
   * a tool call as text instead of calling it, the markup is hidden and — if it names a real
   * tool and the step and tool budgets allow — the call is executed and the conversation
   * continues from its result. When the call cannot be recovered, or the model is stuck
   * repeating itself, the turn ends with a short apology instead of raw markup or a loop.
   */
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const byName = new Map(req.tools.map((t) => [t.name, t]));
    const tools: ToolSet = {};
    for (const t of req.tools) {
      tools[t.name] = {
        description: t.description,
        inputSchema: t.inputSchema,
        execute: async (input: unknown, options: { toolCallId: string }) => t.execute(input, options.toolCallId),
      } as ToolSet[string];
    }
    const hasTools = req.tools.length > 0;
    const guard = new LeakGuard();
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const usage = { inputTokens: 0, outputTokens: 0 };
    let messages: unknown[] = [...req.messages];
    let stepsLeft = req.maxIterations;
    let recovered = 0;

    for (;;) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      req.signal?.addEventListener("abort", onAbort, { once: true });
      let stepsUsed = 0;
      let stoppedByGuard = false;
      let streamError: unknown = null;
      const budget = stepsLeft;
      let model: LanguageModel;
      try {
        model = await this.model();
      } catch (error) {
        req.signal?.removeEventListener("abort", onAbort);
        throw classifyAiError(error, this.id, this.modelId);
      }
      const result = streamText({
        model,
        instructions: req.system,
        messages: messages as never,
        maxOutputTokens: outputFor(this.caps, req.maxOutputTokens),
        temperature: req.temperature,
        abortSignal: controller.signal,
        // Retries would be model calls the daily budget cannot see; the UI offers Retry instead.
        maxRetries: 0,
        ...(this.providerOptions ? { providerOptions: this.providerOptions as never } : {}),
        ...(hasTools
          ? {
              tools,
              // Every further step is another model call: stop at the step cap or when the daily budget is spent.
              stopWhen: ({ steps }: { steps: unknown[] }) => steps.length >= budget || (req.reserveNextStep ? !req.reserveNextStep() : false),
              // On the last allowed step, or once the tool budget is spent, force a plain-text answer.
              prepareStep: ({ stepNumber }: { stepNumber: number }) =>
                stepNumber >= budget - 1 || req.toolBudgetExhausted() ? { toolChoice: "none" as const } : {},
            }
          : {}),
        onError: ({ error }: { error: unknown }) => {
          streamError = error;
        },
      });

      try {
        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta": {
              const text = part.text ? guard.push(part.text) : "";
              if (text) yield { type: "text", delta: text };
              break;
            }
            case "finish-step": {
              stepsUsed++;
              const text = guard.endStep();
              if (text) yield { type: "text", delta: text };
              break;
            }
            case "tool-call":
              guard.markToolActivity();
              yield { type: "tool-start", id: part.toolCallId, name: part.toolName, input: part.input };
              break;
            case "tool-result":
              yield { type: "tool-end", id: part.toolCallId, name: part.toolName, output: part.output };
              break;
            case "tool-error":
              yield {
                type: "tool-end",
                id: part.toolCallId,
                name: part.toolName,
                output: null,
                error: part.error instanceof Error ? part.error.message : String(part.error),
              };
              break;
            case "finish":
              usage.inputTokens += part.totalUsage.inputTokens ?? 0;
              usage.outputTokens += part.totalUsage.outputTokens ?? 0;
              break;
            case "error":
              throw part.error;
            default:
              break;
          }
          if (guard.looping) {
            stoppedByGuard = true;
            controller.abort();
            break;
          }
        }
      } catch (error) {
        if (!stoppedByGuard || req.signal?.aborted) throw classifyAiError(error, this.id, this.modelId);
      } finally {
        req.signal?.removeEventListener("abort", onAbort);
      }
      if (streamError && !stoppedByGuard) throw classifyAiError(streamError, this.id, this.modelId);

      if (stoppedByGuard) {
        yield { type: "text", delta: closing(guard, lastUser) };
        break;
      }
      const leak = guard.takeLeaks();
      if (!leak.text) break;

      const calls = parseLeakedToolCalls(leak.text, new Set(byName.keys()), leak.nameHint).slice(0, 3);
      stepsLeft -= stepsUsed;
      const canContinue =
        calls.length > 0 && recovered < MAX_RECOVERIES && stepsLeft > 0 && !req.toolBudgetExhausted() && (req.reserveNextStep ? req.reserveNextStep() : true);
      if (!canContinue) {
        // Nothing usable after the hidden markup: say so instead of ending on a dangling preamble.
        if (norm(guard.emittedSinceTools).length < 120) yield { type: "text", delta: closing(guard, lastUser) };
        break;
      }

      recovered++;
      const response = await result.response;
      const callParts: unknown[] = [];
      const resultParts: unknown[] = [];
      for (const [i, call] of calls.entries()) {
        const id = `leaked_${recovered}_${i}_${Date.now().toString(36)}`;
        guard.markToolActivity();
        yield { type: "tool-start", id, name: call.name, input: call.input };
        let output: unknown;
        let error: string | undefined;
        try {
          output = await byName.get(call.name)!.execute(call.input, id);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        yield error === undefined ? { type: "tool-end", id, name: call.name, output } : { type: "tool-end", id, name: call.name, output: null, error };
        callParts.push({ type: "tool-call", toolCallId: id, toolName: call.name, input: call.input });
        resultParts.push({
          type: "tool-result",
          toolCallId: id,
          toolName: call.name,
          output: error === undefined ? { type: "json", value: jsonSafe(output) } : { type: "error-text", value: error },
        });
      }
      messages = [
        ...messages,
        ...withoutLeakedMarkup(response.messages as unknown[]),
        { role: "assistant", content: callParts },
        { role: "tool", content: resultParts },
      ];
    }
    yield { type: "usage", usage };
  }
}

/**
 * Cloudflare Workers AI through the AI SDK's official Workers AI provider.
 * Reasoning ("thinking") is disabled by default to keep Neuron usage low.
 */
export class CloudflareWorkersAIProvider extends AiSdkProvider {
  constructor(binding: Ai, modelId: string) {
    const workersai = createWorkersAI({ binding });
    super("workers-ai", modelId, async () => workersai(modelId as Parameters<typeof workersai>[0], { chat_template_kwargs: { enable_thinking: false } }) as LanguageModel);
  }
}

/** At most this many leaked calls are turned into real ones per turn. */
const MAX_RECOVERIES = 3;

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function closing(guard: LeakGuard, lastUser: string): string {
  const text = gracefulStopText(lastUser);
  return guard.emitted && !guard.emitted.endsWith("\n") ? `\n\n${text}` : text;
}

function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}

/** The model's own messages for the steps so far, with any leaked markup cut out of their text. */
export function withoutLeakedMarkup(messages: unknown[]): unknown[] {
  const cut = (text: string) => {
    const at = Math.min(...LEAK_MARKERS.map((m) => text.indexOf(m)).filter((i) => i !== -1), text.length);
    return text.slice(0, at);
  };
  return messages.map((m) => {
    const msg = m as { role: string; content: unknown };
    if (msg.role !== "assistant") return m;
    if (typeof msg.content === "string") return { ...msg, content: cut(msg.content) };
    if (!Array.isArray(msg.content)) return m;
    const content = msg.content
      .map((p: { type: string; text?: string }) => (p.type === "text" && typeof p.text === "string" ? { ...p, text: cut(p.text) } : p))
      .filter((p: { type: string; text?: string }) => !(p.type === "text" && !p.text?.trim()));
    return { ...msg, content };
  }).filter((m) => {
    const msg = m as { role: string; content: unknown };
    return !(msg.role === "assistant" && Array.isArray(msg.content) && msg.content.length === 0);
  });
}
