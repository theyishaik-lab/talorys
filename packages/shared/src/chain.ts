import type { AiFailureReason } from "./attribution";
import type { AiProviderId, FallbackChainEntry, FallbackSettings } from "./schemas";

/**
 * Settings → Model: the whole fallback chain as one ordered list, and its live status
 * (`GET /api/ai/chain`). The list is what a turn actually tries: the chosen model, the selected
 * backup, then `fallback.chain` — duplicates once.
 */

export interface ChainRef {
  provider: AiProviderId;
  model: string;
}

/** How one model in the chain stands right now. */
export type ChainEntryState =
  | "available" // nothing known against it
  | "paused" // a short pause after an overload / per-minute limit / silence
  | "exhausted" // its daily (or monthly) free quota is used up until the reset
  | "not_configured"; // no key / endpoint for it

export interface ChainQuotaCounter {
  remaining: number | null;
  limit: number | null;
  /** "day" | "minute" | "month" when known. */
  window: "day" | "minute" | "month" | null;
  /** ISO time it resets, when known. */
  reset_at: string | null;
}

export interface ChainQuota {
  /** Requests left (OpenRouter's key API, or the last response headers). */
  requests: ChainQuotaCounter | null;
  /** Tokens left in the current window (Groq: per minute), from the last response headers. */
  tokens: ChainQuotaCounter | null;
  /** "key_api": asked the provider just now; "headers": the last response the agent got. */
  source: "key_api" | "headers";
  /** ISO time the numbers were read. */
  as_of: string;
  /** True when the counter covers every model of the provider (OpenRouter's free allowance). */
  shared: boolean;
}

export interface ChainStatusEntry extends ChainRef {
  /** 0 = the chosen model, 1 = the selected backup, then the chain. */
  position: number;
  /** "Nemotron 3 Ultra 550B A55B" */
  label: string;
  /** "OpenRouter", "Google", "Groq", "OVH", "Workers AI" */
  provider_label: string;
  state: ChainEntryState;
  /** ISO time a pause or an exhausted quota ends (null when unknown). */
  until: string | null;
  reason: AiFailureReason | null;
  /** The provider's last words for the pause (English, short). */
  error: string | null;
  /** Null when the provider says nothing about what is left ("unknown"). */
  quota: ChainQuota | null;
}

export interface ChainStatus {
  /** False when the fallback chain is switched off (only the chosen model is tried). */
  enabled: boolean;
  entries: ChainStatusEntry[];
  checked_at: string;
}

const refKey = (r: ChainRef) => `${r.provider}\u0000${r.model}`;

/** The ordered list a turn tries, from the stored settings (duplicates once). Ignores `enabled`. */
export function chainFromSettings(settings: { modelProvider: AiProviderId; model: string; fallback: FallbackSettings }): ChainRef[] {
  const out: ChainRef[] = [];
  const seen = new Set<string>();
  const all: ChainRef[] = [{ provider: settings.modelProvider, model: settings.model }, { provider: settings.fallback.provider, model: settings.fallback.model }, ...(settings.fallback.chain ?? [])];
  for (const r of all) {
    const k = refKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ provider: r.provider, model: r.model });
  }
  return out;
}

/**
 * The settings patch that stores an edited list: the first entry becomes the chosen model, the second
 * the selected backup, the rest the chain. A one-entry list keeps the backup equal to the model (it is
 * tried once) and empties the chain.
 */
export function settingsPatchForChain(list: readonly ChainRef[], enabled?: boolean): {
  modelProvider: AiProviderId;
  model: string;
  fallback: { enabled?: boolean; provider: AiProviderId; model: string; chain: FallbackChainEntry[] };
} {
  const unique: ChainRef[] = [];
  const seen = new Set<string>();
  for (const r of list) {
    const k = refKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(r);
    }
  }
  const [first, second, ...rest] = unique;
  if (!first) throw new Error("The chain needs at least one model");
  const backup = second ?? first;
  return {
    modelProvider: first.provider,
    model: first.model,
    fallback: {
      ...(enabled === undefined ? {} : { enabled }),
      provider: backup.provider,
      model: backup.model,
      chain: rest.map((r) => ({ provider: r.provider, model: r.model })),
    },
  };
}

/** Moves item `from` to index `to` (both clamped); returns a new array. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  const target = Math.max(0, Math.min(out.length, to));
  out.splice(target, 0, item as T);
  return out;
}

/** "groq" from a display name ("Groq Cloud" → "groq-cloud"); a free id when `taken` has it. */
export function endpointIdFromName(name: string, taken: readonly string[] = []): string {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 28) || "api";
  let id = /^[a-z0-9]/.test(base) ? base : `x${base}`.slice(0, 28);
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`.slice(0, 32);
  return id;
}
