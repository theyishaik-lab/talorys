import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import { AppError } from "../api/errors";
import { AiSdkProvider } from "./workers-ai";

/**
 * Google Gemini through the Gemini API (AI Studio key). Function calling, streaming and Hebrew
 * all go through the AI SDK's Google provider; the key is read from the encrypted store on first use.
 */
export class GeminiProvider extends AiSdkProvider {
  constructor(modelId: string, apiKey: () => Promise<string | null>) {
    super("gemini", modelId, async () => {
      const key = await apiKey();
      if (!key) throw new AppError("NOT_CONFIGURED", "Google Gemini needs an API key. Add one in Settings → Model.", { provider: "gemini" });
      return createGoogleGenerativeAI({ apiKey: key })(modelId) as LanguageModel;
    });
  }
}

/** A usable model from the Gemini `models` list: generateContent, and not an image/audio/live/embedding variant. */
export function isGeminiChatModel(name: string, methods: string[] | undefined): boolean {
  const id = name.replace(/^models\//, "");
  if (!/^gemini-\d/.test(id)) return false;
  if (methods && !methods.includes("generateContent")) return false;
  return !/image|tts|audio|live|transcribe|computer-use|embedding|robotics|translate|thinking-exp/i.test(id);
}

/** Lists the models a key can use. Also the cheapest way to verify a key: it costs no generation quota. */
export async function listGeminiModels(apiKey: string, signal?: AbortSignal): Promise<{ id: string; name: string; description: string; context: number | null }[]> {
  const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": apiKey }, signal });
  if (!r.ok) throw new Error(`Gemini answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = (await r.json()) as { models?: { name: string; displayName?: string; description?: string; inputTokenLimit?: number; supportedGenerationMethods?: string[] }[] };
  return (body.models ?? [])
    .filter((m) => isGeminiChatModel(m.name, m.supportedGenerationMethods))
    .map((m) => ({ id: m.name.replace(/^models\//, ""), name: m.displayName ?? m.name, description: m.description ?? "", context: m.inputTokenLimit ?? null }));
}
