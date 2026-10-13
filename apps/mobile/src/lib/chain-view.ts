import type { ChainQuota, ChainStatusEntry } from "@talorys/shared";
import type { StringKey } from "./i18n";

/** Words for Settings → Model → Model chain; the same rules as the web (apps/web/src/lib/chain-view.ts). */
type T = (k: StringKey, v?: Record<string, string | number>) => string;

export function timeLeft(t: T, iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const ms = Date.parse(iso) - now;
  if (!(ms > 0)) return t("m.chain.lessThanMinute");
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return t("m.chain.min", { n: min });
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? t("m.chain.hours", { h, m }) : t("m.chain.hoursOnly", { h });
}

export function stateText(t: T, e: ChainStatusEntry, now = Date.now()): string {
  const head = t(`m.chain.state.${e.state}` as StringKey);
  if (e.state === "paused") {
    const why = e.reason ? t(`m.chain.reason.${e.reason}` as StringKey) : "";
    return [head + (why ? ` (${why})` : ""), e.until ? t("m.chain.back", { time: timeLeft(t, e.until, now) }) : ""].filter(Boolean).join(" · ");
  }
  if (e.state === "exhausted") return [head, e.until ? t("m.chain.resets", { time: timeLeft(t, e.until, now) }) : ""].filter(Boolean).join(" · ");
  if (e.state === "not_configured" && e.reason === "bad_key") return `${head} (${t("m.chain.reason.bad_key")})`;
  return head;
}

const n = (v: number) => v.toLocaleString("en-US");

export function quotaLine(t: T, q: ChainQuota | null): string {
  if (!q?.requests && !q?.tokens) return t("m.chain.quota.unknown");
  const parts: string[] = [];
  const r = q.requests;
  if (r && r.remaining != null) {
    const vars = { remaining: n(r.remaining), limit: r.limit != null ? n(r.limit) : "?" };
    parts.push(t(r.window === "day" ? "m.chain.quota.requestsDay" : r.window === "minute" ? "m.chain.quota.requestsMinute" : "m.chain.quota.requests", vars));
  }
  if (q.tokens?.remaining != null) parts.push(t("m.chain.quota.tokensMinute", { remaining: n(q.tokens.remaining) }));
  if (parts.length === 0) return t("m.chain.quota.unknown");
  if (q.shared) parts.push(t("m.chain.quota.shared"));
  if (q.source === "headers") {
    const d = new Date(q.as_of);
    parts.push(t("m.chain.quota.asOf", { time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` }));
  }
  return parts.join(" · ");
}
