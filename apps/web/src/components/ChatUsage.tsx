import { useEffect, useId, useRef, useState } from "react";
import { Gauge, X } from "lucide-react";
import { Link } from "react-router";
import { useUsage } from "../hooks/queries";
import { useT } from "../lib/i18n";
import { cn } from "../lib/utils";
import { Button, Spinner } from "./ui";

export function ChatUsage() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const usage = useUsage(open ? 15_000 : 60_000);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const data = usage.data;
  const used = data?.today.ai_requests ?? 0;
  const limit = data?.limits.maxAiRequestsPerDay ?? 0;
  const percent = limit > 0 ? Math.min(100, used / limit * 100) : 100;
  const nearLimit = !!data && percent >= 80;

  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    function dismiss(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative" onBlur={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
    }}>
      <Button ref={trigger} variant="ghost" size="icon" aria-label={t("usage.aiUsage")} title={t("usage.aiUsage")}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        className={cn("relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent", nearLimit && "text-warning")}
        onClick={() => {
          if (!open) void usage.refetch();
          setOpen(!open);
        }}>
        <Gauge className="h-[18px] w-[18px]" aria-hidden />
        {nearLimit && <span className="absolute end-1 top-1 h-1.5 w-1.5 rounded-full bg-warning" />}
      </Button>
      {open && (
        <div ref={panel} id={id} role="dialog" aria-modal="false" aria-labelledby={`${id}-title`} tabIndex={-1}
          className="absolute end-0 top-full z-30 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-4 text-sm shadow-lg outline-none animate-fade-in">
          <div className="mb-3 flex items-center justify-between">
            <h3 id={`${id}-title`} className="font-medium text-fg">{t("usage.today")}</h3>
            <Button variant="ghost" size="icon" aria-label={t("usage.close")} className="h-6 w-6" onClick={() => {
              setOpen(false);
              trigger.current?.focus();
            }}><X className="h-3.5 w-3.5" /></Button>
          </div>
          {usage.isLoading ? <div role="status" aria-label={t("usage.loading")} className="flex justify-center py-5"><Spinner /></div>
            : usage.isError ? <div role="alert" className="space-y-2 text-fg-muted">
              <p>{t("usage.loadFailed")}</p>
              <Button variant="outline" size="sm" onClick={() => void usage.refetch()}>{t("push.retry")}</Button>
            </div> : data && <>
              <div className="flex justify-between gap-3 text-fg"><span>{t("usage.requests")}</span><span className="tabular-nums">{used.toLocaleString()} / {limit.toLocaleString()}</span></div>
              <div role="progressbar" aria-label={t("usage.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}
                aria-valuetext={t("usage.progressText", { used, limit })} className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div className={cn("h-full rounded-full transition-all", percent >= 100 ? "bg-danger" : nearLimit ? "bg-warning" : "bg-accent")} style={{ width: `${percent}%` }} />
              </div>
              <p className={cn("mt-2 text-xs", nearLimit ? "text-warning" : "text-fg-muted")}>
                {used >= limit ? t("usage.limitReached") : t("usage.remaining", { n: Math.max(0, limit - used).toLocaleString() })}
              </p>
              <dl className="my-4 space-y-2 text-xs text-fg-muted">
                <div className="flex justify-between gap-3"><dt>{t("usage.tokens")}</dt><dd className="tabular-nums text-fg">{(data.today.input_tokens_estimate + data.today.output_tokens_estimate).toLocaleString()}</dd></div>
                <div className="flex justify-between gap-3"><dt>{t("usage.toolCalls")}</dt><dd className="tabular-nums text-fg">{data.today.tool_calls.toLocaleString()}</dd></div>
                <div className="flex justify-between gap-3"><dt>{t("ai.usage.scheduled")}</dt><dd className="tabular-nums text-fg">{data.today.scheduled_ai_runs.toLocaleString()} / {data.limits.maxScheduledAiRunsPerDay.toLocaleString()}</dd></div>
              </dl>
              <p className="border-t border-border pt-3 text-xs text-fg-subtle">{t("usage.resets")}</p>
              <p className="mt-1 text-xs text-fg-subtle">{t("usage.estimates")}</p>
            </>}
          <Link to="/settings?tab=AI" onClick={() => setOpen(false)} className="mt-3 inline-block text-xs font-medium text-accent hover:underline">{t("usage.viewLimits")}</Link>
        </div>
      )}
    </div>
  );
}
