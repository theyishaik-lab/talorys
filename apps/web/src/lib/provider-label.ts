import type { AiProviderId } from "@talorys/shared";
import type { StringKey } from "./i18n";

/** The provider's name in the UI language ("Google Gemini", "Cloudflare Workers AI", "OpenRouter"). */
export function providerLabel(t: (k: StringKey) => string, id: AiProviderId | string | undefined): string {
  const key = `model.provider.${id}` as StringKey;
  return id === "workers-ai" || id === "gemini" || id === "openrouter" ? t(key) : String(id ?? "");
}
