import type { ChainQuota, ChainStatusEntry } from "@talorys/shared";
import type { StringKey } from "./i18n";

/** Words for Settings → Model → "Model chain" (ChainEditor), kept pure so they are unit-tested. */
type T = (k: StringKey, v?: Record<string, string | number>) => string;

/** "12 min", "3 h 5 min" until an ISO time. */
export function timeLeft(t: T, iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return t("chain.lessThanMinute");
  const min = Math.ceil(ms / 60_000);
  if (min < 1) return t("chain.lessThanMinute");
  if (min < 60) return t("chain.min", { n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? t("chain.hours", { h, m }) : t("chain.hoursOnly", { h });
}

/** "30 of 50 requests left today · shared by all free models", or "Quota: unknown". */
export function quotaLine(t: T, q: ChainQuota | null): string {
  if (!q?.requests && !q?.tokens) return t("chain.quota.unknown");
  const parts: string[] = [];
  const r = q.requests;
  if (r && r.remaining != null) {
    const vars = { remaining: r.remaining.toLocaleString(), limit: r.limit != null ? r.limit.toLocaleString() : "?" };
    parts.push(t(r.window === "day" ? "chain.quota.requestsDay" : r.window === "minute" ? "chain.quota.requestsMinute" : "chain.quota.requests", vars));
  }
  if (q.tokens?.remaining != null) parts.push(t("chain.quota.tokensMinute", { remaining: q.tokens.remaining.toLocaleString() }));
  if (parts.length === 0) return t("chain.quota.unknown");
  if (q.shared) parts.push(t("chain.quota.shared"));
  if (q.source === "headers") parts.push(t("chain.quota.asOf", { time: new Date(q.as_of).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) }));
  return parts.join(" · ");
}

export function stateText(t: T, e: ChainStatusEntry): string {
  const head = t(`chain.state.${e.state}` as StringKey);
  if (e.state === "paused") {
    const why = e.reason ? t(`chain.reason.${e.reason}` as StringKey) : "";
    return [head + (why ? ` (${why})` : ""), e.until ? t("chain.back", { time: timeLeft(t, e.until) }) : ""].filter(Boolean).join(" · ");
  }
  if (e.state === "exhausted") return [head, e.until ? t("chain.resets", { time: timeLeft(t, e.until) }) : ""].filter(Boolean).join(" · ");
  if (e.state === "not_configured" && e.reason === "bad_key") return `${head} (${t("chain.reason.bad_key")})`;
  return head;
}
