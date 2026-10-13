/**
 * Remaining free quota per model, from what the providers themselves report.
 *
 * - Groq (and other OpenAI-compatible APIs) send `x-ratelimit-{limit,remaining,reset}-{requests,tokens}`
 *   on every chat response (Groq: requests per DAY, tokens per MINUTE).
 * - OVH and others send the IETF draft `RateLimit-Limit / -Remaining / -Reset` (seconds).
 * - OpenRouter: `GET /api/v1/key` reports `free_model_daily_requests {used, limit, remaining}` for the
 *   account (read on demand by the status route, not here).
 *
 * Headers are recorded from the turns that actually ran (no extra requests, no quota spent) and kept in
 * `tal_settings` under `ai_quota_seen`, so Settings → Model can show "remaining as of <time>".
 */

export interface QuotaCounter {
  limit: number | null;
  remaining: number | null;
  /** ISO time the counter resets, when the provider said. */
  reset_at: string | null;
  /** "day" | "minute" when known from the provider's conventions, else null. */
  window: "day" | "minute" | null;
}

export interface QuotaSnapshot {
  requests: QuotaCounter | null;
  tokens: QuotaCounter | null;
  /** ISO time the headers were seen. */
  seen_at: string;
}

export interface QuotaStore {
  getJson<T>(key: string): T | null;
  setJson(key: string, value: unknown): void;
}

export const QUOTA_SEEN_KEY = "ai_quota_seen";
/** Snapshots older than this are dropped (a day-window counter is meaningless after two days). */
const KEEP_MS = 48 * 60 * 60 * 1000;
const MAX_ENTRIES = 64;

interface HeaderLike {
  get(name: string): string | null;
}

/** "2m59.56s", "1h2m3s", "7.66s", "120ms" or a plain number of seconds → seconds. */
export function parseDuration(raw: string | null): number | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v);
  let total = 0;
  let matched = false;
  for (const m of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : m[2] === "ms" ? n / 1000 : n;
  }
  return matched ? total : null;
}

const num = (raw: string | null): number | null => {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw.trim().split(/[,;]/)[0]);
  return Number.isFinite(n) ? n : null;
};

function counter(h: HeaderLike, prefix: string, suffix: string, now: number, window: QuotaCounter["window"]): QuotaCounter | null {
  const limit = num(h.get(`${prefix}limit${suffix}`));
  const remaining = num(h.get(`${prefix}remaining${suffix}`));
  if (limit == null && remaining == null) return null;
  const reset = parseDuration(h.get(`${prefix}reset${suffix}`));
  return { limit, remaining, reset_at: reset == null ? null : new Date(now + reset * 1000).toISOString(), window };
}

/** Reads the rate-limit headers of one response; null when it carries none. */
export function parseRateLimitHeaders(h: HeaderLike, now = Date.now(), opts: { requestsWindow?: QuotaCounter["window"] } = {}): QuotaSnapshot | null {
  // Groq / OpenAI style: per-requests and per-tokens counters (Groq: requests per day, tokens per minute).
  let requests = counter(h, "x-ratelimit-", "-requests", now, opts.requestsWindow ?? null);
  let tokens = counter(h, "x-ratelimit-", "-tokens", now, "minute");
  // IETF draft (OVH): one request counter, reset in seconds.
  if (!requests) requests = counter(h, "ratelimit-", "", now, opts.requestsWindow ?? null);
  // Plain x-ratelimit-limit / -remaining (OpenRouter and others).
  if (!requests) requests = counter(h, "x-ratelimit-", "", now, opts.requestsWindow ?? null);
  if (!requests && !tokens) return null;
  if (tokens && tokens.limit == null && tokens.remaining == null) tokens = null;
  return { requests, tokens, seen_at: new Date(now).toISOString() };
}

const entryKey = (provider: string, model: string) => `${provider}\u0000${model}`;

/** The last rate-limit headers each model's provider sent. */
export class QuotaObservations {
  constructor(
    private readonly store: QuotaStore,
    private readonly now: () => number = Date.now,
  ) {}

  private read(): Record<string, QuotaSnapshot> {
    const v = this.store.getJson<Record<string, QuotaSnapshot>>(QUOTA_SEEN_KEY);
    return v && typeof v === "object" ? v : {};
  }

  record(provider: string, model: string, snapshot: QuotaSnapshot): void {
    const all = this.read();
    all[entryKey(provider, model)] = snapshot;
    const cutoff = this.now() - KEEP_MS;
    const kept = Object.entries(all)
      .filter(([, s]) => Date.parse(s.seen_at) > cutoff)
      .sort((a, b) => b[1].seen_at.localeCompare(a[1].seen_at))
      .slice(0, MAX_ENTRIES);
    this.store.setJson(QUOTA_SEEN_KEY, Object.fromEntries(kept));
  }

  get(provider: string, model: string): QuotaSnapshot | null {
    const s = this.read()[entryKey(provider, model)];
    if (!s || Date.parse(s.seen_at) < this.now() - KEEP_MS) return null;
    return s;
  }
}

/**
 * A fetch that records the rate-limit headers of every response before handing it back unchanged.
 * Recording never throws into the request.
 */
export function observingFetch(onHeaders: (snapshot: QuotaSnapshot) => void, opts: { requestsWindow?: QuotaCounter["window"]; base?: typeof fetch } = {}): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const response = await (opts.base ?? fetch)(input, init);
    try {
      const snapshot = parseRateLimitHeaders(response.headers, Date.now(), { requestsWindow: opts.requestsWindow });
      if (snapshot) onHeaders(snapshot);
    } catch {
      /* never break a turn over bookkeeping */
    }
    return response;
  };
  return wrapped as typeof fetch;
}

/** The window of an endpoint's request counter, from the provider's documented convention. */
export function requestsWindowFor(baseURL: string): QuotaCounter["window"] {
  // Groq: "x-ratelimit-limit-requests always refers to Requests Per Day" (console.groq.com/docs/rate-limits).
  if (/(^|[./])groq\.com(\/|:|$)/.test(baseURL.replace(/^https?:\/\//, ""))) return "day";
  // OVH AI Endpoints: RateLimit-* is per minute.
  if (baseURL.includes("ovh.net")) return "minute";
  return null;
}
