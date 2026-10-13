import { type AiProviderId, type ChainQuota, type ChainRef, type ChainStatus, type ChainStatusEntry, chainFromSettings, endpointShortName, modelLabel, providerShortName, type Settings, splitEndpointModel } from "@talorys/shared";
import type { ModelCooldowns } from "./cooldown";
import { nextUtcMidnight } from "./cooldown";
import type { QuotaObservations } from "./quota";

/** OpenRouter's account-wide free allowance (`GET /api/v1/key` → `free_model_daily_requests`). */
export interface OpenRouterAllowance {
  used: number | null;
  limit: number | null;
  remaining: number | null;
}

export interface ChainStatusDeps {
  cooldowns: Pick<ModelCooldowns, "active">;
  quotas: Pick<QuotaObservations, "get">;
  /** Whether a (provider, model) can be called at all: a key stored, an endpoint registered, a binding. */
  configured: (ref: ChainRef) => boolean;
  /** The registered endpoint's display name, for "openai-compatible" models. */
  endpointName: (id: string) => string | null;
  /** OpenRouter's free allowance right now (null when unknown or no key). */
  openRouter: OpenRouterAllowance | null;
  now: number;
}

const HOUR = 3_600_000;

function providerLabel(ref: ChainRef, endpointName: (id: string) => string | null): string {
  if (ref.provider === "openai-compatible") {
    const id = splitEndpointModel(ref.model)?.endpoint ?? "";
    return endpointName(id) ?? endpointShortName(ref.model) ?? id;
  }
  return providerShortName(ref.provider);
}

/** Builds the status of every model in the chain from what the agent knows; no provider is called here. */
export function chainStatus(settings: Pick<Settings, "modelProvider" | "model" | "fallback">, deps: ChainStatusDeps): ChainStatus {
  const list = chainFromSettings(settings);
  const at = new Date(deps.now).toISOString();
  const entries = list.map((ref, position): ChainStatusEntry => {
    const base: ChainStatusEntry = {
      ...ref,
      position,
      label: modelLabel(ref.model) || ref.model,
      provider_label: providerLabel(ref, deps.endpointName),
      state: "available",
      until: null,
      reason: null,
      error: null,
      quota: null,
    };
    // What is left, where the provider tells.
    if (ref.provider === "openrouter" && ref.model.endsWith(":free") && deps.openRouter && (deps.openRouter.remaining != null || deps.openRouter.limit != null)) {
      base.quota = {
        requests: { remaining: deps.openRouter.remaining, limit: deps.openRouter.limit, window: "day", reset_at: new Date(nextUtcMidnight(deps.now)).toISOString() },
        tokens: null,
        source: "key_api",
        as_of: at,
        shared: true,
      };
    } else {
      const seen = deps.quotas.get(ref.provider, ref.model);
      if (seen) {
        const fresh = (c: ChainQuota["requests"]) => {
          // A counter whose window has reset since it was seen is back to its limit.
          if (!c) return null;
          if (c.reset_at && Date.parse(c.reset_at) <= deps.now) return { ...c, remaining: c.limit, reset_at: null };
          return c;
        };
        base.quota = { requests: fresh(seen.requests), tokens: fresh(seen.tokens), source: "headers", as_of: seen.seen_at, shared: false };
      }
    }
    if (!deps.configured(ref)) return { ...base, state: "not_configured", reason: "not_configured" };
    const pause = deps.cooldowns.active(ref.provider, ref.model);
    if (pause) {
      const long = Date.parse(pause.until) - deps.now > HOUR;
      const daily = pause.reason === "quota" && (pause.window === "day" || (pause.window === undefined && long));
      const state = daily ? "exhausted" : pause.reason === "not_configured" || pause.reason === "bad_key" ? "not_configured" : "paused";
      return { ...base, state, until: pause.until, reason: pause.reason, error: pause.error };
    }
    // Nothing paused, but the provider's own counter says nothing is left.
    const req = base.quota?.requests;
    if (req && req.remaining === 0) {
      const until = req.reset_at ?? (req.window === "day" ? new Date(nextUtcMidnight(deps.now)).toISOString() : null);
      if (!until || Date.parse(until) > deps.now) return { ...base, state: req.window === "minute" ? "paused" : "exhausted", until, reason: "quota" };
    }
    return base;
  });
  return { enabled: settings.fallback.enabled, entries, checked_at: at };
}

/** A provider id that needs a stored key to be called. */
export function needsKey(provider: AiProviderId): provider is "gemini" | "openrouter" {
  return provider === "gemini" || provider === "openrouter";
}
