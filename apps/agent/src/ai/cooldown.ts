import type { AiAttempt, AiFailureReason } from "@talorys/shared";
import type { AppError } from "../api/errors";
import { detailsOf, reasonOf } from "./attribution";

/**
 * Models that failed recently are paused instead of being asked again on every message.
 *
 * Without this a spent daily quota costs every later turn one failed request (and a timed-out model
 * costs the whole 15 s watchdog) before the chain reaches a model that can answer. A pause lasts:
 *  - a DAILY quota (Gemini "PerDay", OpenRouter "free-models-per-day", Workers AI 4006): until the
 *    provider's own "retry in" / reset time, else the next 00:00 UTC — at most 24 h;
 *  - a per-minute rate limit: the provider's hint, else 60 s (at most 1 h);
 *  - overloaded (5xx / "high demand"), no answer within the watchdog, or an unknown error: a short
 *    pause that doubles with each consecutive failure (overload 1 → 2 → 4 … min, silence 5 → 10 …
 *    min), capped at 30 min, and reset by the model's next success;
 *  - the provider does not offer the model: 6 h; a rejected key 1 h; no key 10 min.
 * OpenRouter's free allowance and Workers AI's neurons are the account's, so those pauses cover
 * every model of that provider. When every model in the chain is paused, the turn tries them all
 * anyway — the person never gets "nothing was tried".
 */

export interface CooldownEntry {
  /** ISO time the pause ends. */
  until: string;
  reason: AiFailureReason;
  /** Consecutive failures that set this pause (drives the doubling). */
  strikes: number;
  /** "provider" when it covers every model of the provider. */
  scope: "model" | "provider";
  /** The provider's message, shortened. */
  error: string;
  /** For a quota pause: whether the provider's DAILY or per-minute allowance ran out. */
  window?: "day" | "minute";
}

export interface CooldownStore {
  getJson<T>(key: string): T | null;
  setJson(key: string, value: unknown): void;
}

export const COOLDOWNS_KEY = "ai_cooldowns";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MAX_BACKOFF = 30 * MINUTE;
const MAX_DAILY = 24 * HOUR;
/** How long after a pause ends its strikes still count. */
const STRIKE_MEMORY = 6 * HOUR;

type Table = Record<string, CooldownEntry>;

export function cooldownKey(provider: string, model: string | null): string {
  return `${provider}\u0000${model ?? "*"}`;
}

/** The next 00:00 UTC after `now` (OpenRouter and Workers AI reset their free allowances then). */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * How long to pause a model after `error`, or null when the failure says nothing about the model
 * (a cancelled turn). `strikes` is the number of consecutive failures including this one.
 */
export function cooldownFor(error: unknown, now: number, strikes = 1): { ms: number; scope: "model" | "provider"; window?: "day" | "minute" } | null {
  const d = detailsOf(error);
  const reason = reasonOf(error);
  const hint = typeof d.retry_after_s === "number" && d.retry_after_s > 0 ? d.retry_after_s * 1000 : null;
  const scope = d.scope === "provider" ? "provider" : "model";
  const doubling = (base: number) => Math.min(MAX_BACKOFF, base * 2 ** Math.max(0, Math.min(10, strikes - 1)));
  switch (reason) {
    case "quota":
      if (d.quota_window === "day") return { ms: clamp(hint ?? nextUtcMidnight(now) - now, 10 * MINUTE, MAX_DAILY), scope, window: "day" };
      return { ms: clamp(hint ?? MINUTE, 10_000, HOUR), scope, window: "minute" };
    case "overloaded":
      return { ms: doubling(MINUTE), scope: "model" };
    case "timeout":
      return { ms: doubling(5 * MINUTE), scope: "model" };
    case "no_model":
      return { ms: 6 * HOUR, scope: "model" };
    case "bad_key":
      return { ms: HOUR, scope: "provider" };
    case "not_configured":
      return { ms: 10 * MINUTE, scope: "provider" };
    default:
      return { ms: doubling(MINUTE), scope: "model" };
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** The pauses, kept in the agent's own settings table so they survive restarts. */
export class ModelCooldowns {
  constructor(
    private readonly store: CooldownStore,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): Table {
    const t = this.store.getJson<Table>(COOLDOWNS_KEY);
    return t && typeof t === "object" ? t : {};
  }

  private write(t: Table): void {
    const live: Table = {};
    const now = this.now();
    // An ended pause is kept for a while so a model that fails again soon pauses longer (strikes).
    for (const [k, v] of Object.entries(t)) if (Date.parse(v.until) > now - STRIKE_MEMORY) live[k] = v;
    this.store.setJson(COOLDOWNS_KEY, live);
  }

  /** The pause covering this model right now (its own, or its provider's), else null. */
  active(provider: string, model: string): (CooldownEntry & { key: string }) | null {
    const t = this.read();
    const now = this.now();
    let best: (CooldownEntry & { key: string }) | null = null;
    for (const key of [cooldownKey(provider, model), cooldownKey(provider, null)]) {
      const e = t[key];
      if (e && Date.parse(e.until) > now && (!best || Date.parse(e.until) > Date.parse(best.until))) best = { ...e, key };
    }
    return best;
  }

  /** Records a failure; returns the pause it set (null when the failure sets none). */
  failed(provider: string, model: string, error: AppError | unknown): CooldownEntry | null {
    const t = this.read();
    const own = t[cooldownKey(provider, model)];
    const strikes = (own && Date.parse(own.until) > this.now() - STRIKE_MEMORY ? own.strikes : 0) + 1;
    const c = cooldownFor(error, this.now(), strikes);
    if (!c) return null;
    const message = error instanceof Error ? error.message : String(error);
    const entry: CooldownEntry = {
      until: new Date(this.now() + c.ms).toISOString(),
      reason: reasonOf(error),
      strikes,
      scope: c.scope,
      error: message.slice(0, 200),
      ...(c.window ? { window: c.window } : {}),
    };
    t[cooldownKey(provider, model)] = { ...entry, scope: "model" };
    if (c.scope === "provider") t[cooldownKey(provider, null)] = { ...entry, strikes: 0 };
    this.write(t);
    return entry;
  }

  /** The model answered: its pause, its strikes and its provider's pause end. */
  succeeded(provider: string, model: string): void {
    const t = this.read();
    const keys = [cooldownKey(provider, model), cooldownKey(provider, null)];
    if (!keys.some((k) => k in t)) return;
    for (const k of keys) delete t[k];
    this.write(t);
  }

  /** Every pause still running, for Settings and diagnostics. */
  list(): { provider: string; model: string | null; until: string; reason: AiFailureReason; scope: "model" | "provider"; error: string; window?: "day" | "minute" }[] {
    const now = this.now();
    return Object.entries(this.read())
      .filter(([, e]) => Date.parse(e.until) > now)
      .map(([k, e]) => {
        const [provider = "", model = "*"] = k.split("\u0000");
        return { provider, model: model === "*" ? null : model, until: e.until, reason: e.reason, scope: e.scope, error: e.error, ...(e.window ? { window: e.window } : {}) };
      })
      .sort((a, b) => a.until.localeCompare(b.until));
  }

  /** Ends every pause (after a key or model change in Settings). */
  clear(provider?: string): void {
    if (!provider) {
      this.store.setJson(COOLDOWNS_KEY, {});
      return;
    }
    const t = this.read();
    for (const k of Object.keys(t)) if (k.startsWith(`${provider}\u0000`)) delete t[k];
    this.write(t);
  }
}

/** A skipped model as an attempt in the turn's attribution ("Gemini 3.8 Flash (Google): עומס (בהשהיה)"). */
export function skippedAttempt(provider: string, model: string, entry: CooldownEntry): AiAttempt {
  return {
    provider,
    model,
    code: entry.reason === "quota" ? "AI_QUOTA_EXHAUSTED" : entry.reason === "not_configured" || entry.reason === "bad_key" ? "NOT_CONFIGURED" : "AI_UNAVAILABLE",
    reason: entry.reason,
    skipped: true,
    until: entry.until,
    error: `Paused until ${entry.until} after: ${entry.error}`.slice(0, 300),
  };
}
