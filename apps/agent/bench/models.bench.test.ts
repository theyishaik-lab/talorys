import { env } from "cloudflare:workers";
import { it } from "vitest";
import { createWorkersAI } from "workers-ai-provider";
import { inAgent } from "../test/helpers";
import { AgentRunner } from "../src/agent/runner";
import { CloudflareWorkersAIProvider } from "../src/ai/workers-ai";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";
import { withOpenConnector } from "../src/openconnector";
import { semanticExtensions } from "../src/semantic";
import type { Env } from "../src/env";

const E = env as unknown as Record<string, string>;

export const PROMPTS = [
  "מה שלושת המיילים האחרונים שלי",
  "מה יש לי ביומן השבוע",
  "אילו קבצים יש לי בדרייב",
  "אילו ריפוזיטוריז יש לי בגיטהאב",
  "תכין טיוטת מייל ל-theyishaik@gmail.com עם הנושא \"בדיקה\" ותוכן קצר שאומר שזה מייל בדיקה מטלוריס",
  "תסביר לי בשתי שורות מה ההבדל בין RAM לזיכרון אחסון",
];

/** Records model calls (with tool steps) and usage around the real provider. */
class Recorder implements AIProvider {
  readonly id = "workers-ai";
  usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  calls: { name: string; input: unknown; output?: string; error?: string }[] = [];
  constructor(private readonly inner: AIProvider) {}
  async generate(req: GenerateRequest) {
    const r = await this.inner.generate(req);
    this.usage.inputTokens += r.usage.inputTokens;
    this.usage.outputTokens += r.usage.outputTokens;
    this.usage.calls++;
    return r;
  }
  stream(req: GenerateRequest) {
    return this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    const reserve = req.reserveNextStep;
    this.usage.calls++;
    const wrapped: ToolRequest = { ...req, reserveNextStep: () => { const ok = reserve ? reserve() : true; if (ok) this.usage.calls++; return ok; } };
    for await (const ev of this.inner.generateWithTools(wrapped)) {
      if (ev.type === "tool-start") this.calls.push({ name: ev.name, input: ev.input });
      if (ev.type === "tool-end") {
        const c = this.calls[this.calls.length - 1];
        if (c) { c.output = JSON.stringify(ev.output ?? null).slice(0, 300); c.error = ev.error; }
      }
      if (ev.type === "usage") {
        this.usage.inputTokens += ev.usage.inputTokens;
        this.usage.outputTokens += ev.usage.outputTokens;
      }
      yield ev;
    }
  }
}

it("bench", async () => {
  const models = E.BENCH_MODELS.split(",").map((s) => s.trim()).filter(Boolean);
  const pick = E.BENCH_PROMPTS ? E.BENCH_PROMPTS.split(",").map(Number) : PROMPTS.map((_, i) => i);
  for (const model of models) {
    for (const pi of pick) {
      const prompt = PROMPTS[pi]!;
      await inAgent(async (agent) => {
        const services = agent.services;
        services.settings.update({ timezone: E.BENCH_TZ } as never);
        const real = new CloudflareWorkersAIProvider({} as Ai, model);
        (real as unknown as { workersai: unknown }).workersai = createWorkersAI({ accountId: E.BENCH_CF_ACCOUNT, apiKey: E.BENCH_CF_TOKEN });
        const rec = new Recorder(real);
        const benchEnv = { ...(agent as unknown as { env: Env }).env, OPEN_CONNECTOR_URL: E.BENCH_OC_URL, OPEN_CONNECTOR_TOKEN: E.BENCH_OC_TOKEN } as Env;
        const runner = new AgentRunner(services, rec, withOpenConnector(semanticExtensions(services, benchEnv), services, benchEnv));
        const started = Date.now();
        let firstText: number | null = null;
        let text = "";
        const tools: { name: string; input: unknown; status: string; error?: string }[] = [];
        let error: string | null = null;
        try {
          for await (const ev of runner.chat({ message: prompt, signal: new AbortController().signal })) {
            if (ev.type === "text") { if (firstText === null) firstText = Date.now() - started; text += ev.delta; }
            if (ev.type === "tool" && ev.tool.status !== "running") tools.push({ name: ev.tool.name, input: ev.tool.label, status: ev.tool.approval ? `approval:${ev.tool.approval.status}` : ev.tool.status, error: ev.tool.error });
            if (ev.type === "error") error = `${ev.code}: ${ev.message}`;
            if (ev.type === "done") text = ev.message.content;
          }
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const row = { model, prompt: pi, ms: Date.now() - started, firstTextMs: firstText, usage: rec.usage, calls: rec.calls, tools, error, text };
        console.log("BENCHROW " + JSON.stringify(row));
      });
    }
  }
});
