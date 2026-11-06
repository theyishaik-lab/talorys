import { describe, expect, it } from "vitest";
import { DEFAULT_FALLBACK, RETIRED_WORKERS_AI_MODELS } from "@talorys/shared";
import { workersAiModelsFromCatalog } from "../src/ai/catalog";
import { replaceRetiredModels } from "../src/services/settings";
import { inAgent } from "./helpers";

const QWEN = "@cf/qwen/qwen3-30b-a3b-fp8";
const GEMMA = "@cf/google/gemma-4-26b-a4b-it";

describe("retired Workers AI models", () => {
  it("maps Qwen3 30B to Gemma 4", () => {
    expect(RETIRED_WORKERS_AI_MODELS[QWEN]).toBe(GEMMA);
  });

  it("moves a saved model, backup and chain entry off a retired model", () => {
    const out = replaceRetiredModels({
      modelProvider: "workers-ai",
      model: QWEN,
      fallback: { ...DEFAULT_FALLBACK, enabled: true, provider: "workers-ai", model: QWEN, chain: [
        { provider: "workers-ai", model: QWEN },
        { provider: "workers-ai", model: GEMMA },
        { provider: "gemini", model: "gemini-3.5-flash" },
      ] },
    });
    expect(out.model).toBe(GEMMA);
    expect(out.fallback.model).toBe(GEMMA);
    expect(out.fallback.chain).toEqual([
      { provider: "workers-ai", model: GEMMA },
      { provider: "gemini", model: "gemini-3.5-flash" },
    ]);
  });

  it("leaves other providers alone", () => {
    const out = replaceRetiredModels({ modelProvider: "openrouter", model: "qwen/qwen3-30b-a3b-fp8:free", fallback: { ...DEFAULT_FALLBACK } });
    expect(out.model).toBe("qwen/qwen3-30b-a3b-fp8:free");
  });

  it("drops retired models from the live Workers AI list", () => {
    const rows = [QWEN, GEMMA].map((name) => ({ name, task: { name: "Text Generation" }, properties: [{ property_id: "function_calling", value: "true" }] }));
    expect(workersAiModelsFromCatalog(rows).map((m) => m.id)).toEqual([GEMMA]);
  });

  it("a stored retired choice reads back as its replacement", async () => {
    await inAgent((agent) => {
      const s = agent.services.settings;
      const before = s.raw();
      try {
        s.setJson("app.settings", { ...before, modelProvider: "workers-ai", model: QWEN });
        expect(s.get().model).toBe(GEMMA);
      } finally {
        s.setJson("app.settings", before);
      }
    });
  });
});
