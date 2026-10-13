import { type AiProviderId, type CatalogModel, type CatalogProvider, DEFAULT_MODEL, GEMINI_STATIC_MODELS, type ModelCatalog, PROVIDER_KEY_URLS } from "@talorys/shared";
import { listGeminiModels } from "./gemini";
import type { ProviderKeyStore } from "./keys";
import { listOpenRouterModels } from "./openrouter";
import { PROVIDER_NAMES } from "./provider";

/**
 * The model lists Settings → Model shows, one per provider: Workers AI from the binding's own
 * catalog (text generation with function calling), Gemini from the API when a key is stored
 * (a static list before that), OpenRouter's `:free` models from its public list. Lists are
 * cached in the Durable Object's memory for an hour; a failed fetch shows the static list and
 * the reason.
 */
const CACHE_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

/** Models Talorys has run with tool calling, in the order the UI prefers them. */
const RECOMMENDED = new Set<string>([
  "@cf/google/gemma-4-26b-a4b-it",
  "@cf/zai-org/glm-4.7-flash",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash",
  "google/gemma-4-26b-a4b-it:free",
]);

/** Rough speed/quality tiers by name, for the row's tags. */
export function tiersOf(id: string, params?: number | null): { speed: CatalogModel["speed"]; quality: CatalogModel["quality"] } {
  const s = id.toLowerCase();
  const size = params ?? sizeFromId(s);
  const has = (re: RegExp) => re.test(s);
  if (has(/(^|[-_/ .])(lite|mini|nano|micro|lightning)([-_:. ]|$)/) || (size !== null && size <= 4)) return { speed: "fast", quality: "basic" };
  // Mixture-of-experts with a few billion active parameters answers at small-model speed.
  if (has(/-a\d{1,2}b\b/)) return { speed: "fast", quality: "good" };
  if (has(/flash|fast|small/)) return { speed: "fast", quality: "good" };
  if (has(/(^|[-_/ .])(pro|ultra)([-_:. ]|$)|\b(70|72|120|235|405|550)b\b|k2|glm-5|deepseek-v4|\br1\b|qwq/) || (size !== null && size > 32)) return { speed: "slow", quality: "best" };
  if (size !== null && size <= 32) return { speed: "fast", quality: "good" };
  return { speed: "balanced", quality: "good" };
}

function sizeFromId(s: string): number | null {
  const m = s.match(/(?:^|[-_/ ])(\d+(?:\.\d+)?)b\b/);
  return m ? Number(m[1]) : null;
}

function short(text: string, max = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

interface CfModel {
  name: string;
  description?: string;
  task?: { name?: string };
  properties?: { property_id: string; value: unknown }[];
}

export function workersAiModelsFromCatalog(rows: CfModel[]): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const row of rows) {
    if (row.task?.name && row.task.name !== "Text Generation") continue;
    const props = new Map((row.properties ?? []).map((p) => [p.property_id, p.value]));
    const tools = String(props.get("function_calling")) === "true";
    if (!tools) continue;
    if (/lora|guard|clef/i.test(row.name)) continue;
    const ctx = Number(props.get("context_window"));
    const price = props.get("price");
    let p: CatalogModel["price"] = null;
    if (Array.isArray(price)) {
      const input = (price as { unit?: string; price?: number }[]).find((x) => /input/.test(x.unit ?? "") && !/cached/.test(x.unit ?? ""))?.price;
      const output = (price as { unit?: string; price?: number }[]).find((x) => /output/.test(x.unit ?? ""))?.price;
      if (typeof input === "number" && typeof output === "number") p = { input, output };
    }
    const tiers = tiersOf(row.name, Number(props.get("params")) || null);
    out.push({
      id: row.name,
      name: row.name.split("/").slice(2).join("/") || row.name,
      description: short(row.description ?? ""),
      context: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
      tools: true,
      // Every Workers AI model draws on the same free daily allowance (10,000 Neurons), then Cloudflare's per-token price.
      free: true,
      speed: tiers.speed,
      quality: tiers.quality,
      price: p,
      recommended: RECOMMENDED.has(row.name),
    });
  }
  return sortModels(out);
}

function sortModels(models: CatalogModel[]): CatalogModel[] {
  return [...models].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended) || a.name.localeCompare(b.name));
}

function geminiStatic(): CatalogModel[] {
  return GEMINI_STATIC_MODELS.map((id) => {
    const tiers = tiersOf(id);
    return {
      id,
      name: id.replace(/^gemini-/, "Gemini ").replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      description: id.includes("2.5") ? "Previous generation; Google limits 2.5 models to accounts that already used them." : "Current generation on the Gemini API free tier.",
      context: id.includes("pro") ? 1_048_576 : 1_048_576,
      tools: true,
      free: true,
      speed: tiers.speed,
      quality: id.includes("pro") ? "best" : tiers.quality,
      price: null,
      recommended: RECOMMENDED.has(id),
    };
  });
}

function withTimeout(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

interface CacheEntry {
  at: number;
  models: CatalogModel[];
  source: "live" | "static";
  error: string | null;
}

export class ModelCatalogService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly ai: Ai | undefined,
    private readonly keys: ProviderKeyStore,
    private readonly fetchCfModels: (ai: Ai) => Promise<CfModel[]> = (ai) => ai.models({ task: "Text Generation", per_page: 100 }) as Promise<CfModel[]>,
  ) {}

  invalidate(provider?: AiProviderId): void {
    if (provider) for (const k of [...this.cache.keys()]) k.startsWith(provider) && this.cache.delete(k);
    else this.cache.clear();
  }

  async catalog(current: { provider: AiProviderId; model: string }, opts: { refresh?: boolean } = {}): Promise<ModelCatalog> {
    const info = this.keys.info();
    const [cf, gemini, openrouter] = await Promise.all([this.workersAi(opts.refresh), this.gemini(opts.refresh), this.openrouter(opts.refresh)]);
    const providers: CatalogProvider[] = [
      { id: "workers-ai", name: PROVIDER_NAMES["workers-ai"], connected: !!this.ai, keyHint: null, keyAddedAt: null, needsKey: false, keyUrl: null, ...cf },
      { id: "gemini", name: PROVIDER_NAMES.gemini, connected: info.gemini.set, keyHint: info.gemini.hint, keyAddedAt: info.gemini.added_at, needsKey: true, keyUrl: PROVIDER_KEY_URLS.gemini, ...gemini },
      { id: "openrouter", name: PROVIDER_NAMES.openrouter, connected: info.openrouter.set, keyHint: info.openrouter.hint, keyAddedAt: info.openrouter.added_at, needsKey: true, keyUrl: PROVIDER_KEY_URLS.openrouter, ...openrouter },
    ];
    // The chosen model is always listed, even when the live list no longer carries it.
    const chosen = providers.find((p) => p.id === current.provider);
    if (chosen && !chosen.models.some((m) => m.id === current.model)) {
      const tiers = tiersOf(current.model);
      chosen.models.unshift({ id: current.model, name: current.model, description: "", context: null, tools: true, free: current.provider !== "openrouter" || current.model.endsWith(":free"), speed: tiers.speed, quality: tiers.quality, price: null });
    }
    return { providers, current, fetched_at: new Date().toISOString() };
  }

  private async cached(key: string, refresh: boolean | undefined, load: () => Promise<CatalogModel[]>, fallback: CatalogModel[]): Promise<Omit<CacheEntry, "at">> {
    const hit = this.cache.get(key);
    if (hit && !refresh && Date.now() - hit.at < CACHE_MS) return hit;
    try {
      const models = await load();
      const entry: CacheEntry = { at: Date.now(), models, source: "live", error: null };
      this.cache.set(key, entry);
      return entry;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`model list for ${key} failed`, message);
      const entry: CacheEntry = { at: Date.now(), models: hit?.models ?? fallback, source: hit?.source ?? "static", error: message.slice(0, 200) };
      // A failure is not cached for long: the next open retries.
      this.cache.set(key, { ...entry, at: Date.now() - CACHE_MS + 60_000 });
      return entry;
    }
  }

  private workersAi(refresh?: boolean) {
    const fallback = workersAiModelsFromCatalog(STATIC_CF);
    if (!this.ai) return Promise.resolve({ models: fallback, source: "static" as const, error: "No Workers AI binding." });
    const ai = this.ai;
    return this.cached("workers-ai", refresh, async () => {
      const rows = await this.fetchCfModels(ai);
      const models = workersAiModelsFromCatalog(rows);
      if (models.length === 0) throw new Error("The catalog listed no text-generation model with function calling.");
      return models;
    }, fallback);
  }

  private gemini(refresh?: boolean) {
    const fallback = geminiStatic();
    if (!this.keys.has("gemini")) return Promise.resolve({ models: fallback, source: "static" as const, error: null });
    return this.cached("gemini", refresh, async () => {
      const key = await this.keys.get("gemini");
      const rows = await listGeminiModels(key!, withTimeout(FETCH_TIMEOUT_MS));
      const models = rows.map((m) => {
        const tiers = tiersOf(m.id);
        return { id: m.id, name: m.name, description: short(m.description), context: m.context, tools: true, free: true, speed: tiers.speed, quality: m.id.includes("pro") ? ("best" as const) : tiers.quality, price: null, recommended: RECOMMENDED.has(m.id) };
      });
      if (models.length === 0) throw new Error("The key lists no Gemini chat model.");
      return sortModels(models);
    }, fallback);
  }

  private openrouter(refresh?: boolean) {
    return this.cached("openrouter", refresh, async () => {
      const key = this.keys.has("openrouter") ? await this.keys.get("openrouter") : null;
      const rows = await listOpenRouterModels({ apiKey: key, freeOnly: true, signal: withTimeout(FETCH_TIMEOUT_MS) });
      const models = rows
        .filter((m) => m.tools && !/safety|guard/i.test(m.id))
        .map((m) => {
          const tiers = tiersOf(m.id);
          return { id: m.id, name: m.name, description: short(m.description), context: m.context, tools: m.tools, free: m.free, speed: tiers.speed, quality: tiers.quality, price: m.price, recommended: RECOMMENDED.has(m.id) };
        });
      if (models.length === 0) throw new Error("OpenRouter lists no free model with tool calling right now.");
      return sortModels(models);
    }, []);
  }
}

/** Shown when the catalog cannot be fetched. From developers.cloudflare.com/workers-ai/models, Oct 13, 2026. */
const STATIC_CF: CfModel[] = [
  { name: DEFAULT_MODEL, description: "GLM-4.7-Flash: fast, multilingual, 131k context.", properties: [{ property_id: "function_calling", value: "true" }, { property_id: "context_window", value: "131072" }] },
  { name: "@cf/google/gemma-4-26b-a4b-it", description: "Gemma 4 26B (4B active): strong quality at flash speed, 256k context.", properties: [{ property_id: "function_calling", value: "true" }, { property_id: "context_window", value: "256000" }] },
  { name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", description: "Llama 3.3 70B, fp8, tuned for speed.", properties: [{ property_id: "function_calling", value: "true" }, { property_id: "context_window", value: "24000" }] },
  { name: "@cf/qwen/qwen3-30b-a3b-fp8", description: "Qwen3 30B (3B active), fast.", properties: [{ property_id: "function_calling", value: "true" }, { property_id: "context_window", value: "32768" }] },
  { name: "@cf/mistralai/mistral-small-3.1-24b-instruct", description: "Mistral Small 3.1 24B.", properties: [{ property_id: "function_calling", value: "true" }, { property_id: "context_window", value: "128000" }] },
];
