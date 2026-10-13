import { useMemo, useState } from "react";
import type { Automation, AutomationKind, AutomationRun, ScheduleSpec } from "@talorys/shared";
import { AlarmClock, Bell, Bot, CalendarClock, ListChecks, Plus, Trash2 } from "lucide-react";
import { Badge, Button, Card, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Switch, Textarea } from "../components/ui";
import { keys, useApiMutation, useAutomations } from "../hooks/queries";
import { api } from "../lib/api";
import { type StringKey, useT } from "../lib/i18n";
import { cn, formatDateTime, relativeTime } from "../lib/utils";

const KIND_META: Record<AutomationKind, { label: StringKey; icon: typeof Bell; hint: StringKey }> = {
  reminder: { label: "auto.kind.reminder", icon: Bell, hint: "auto.kind.reminderHint" },
  task_digest: { label: "auto.kind.task_digest", icon: ListChecks, hint: "auto.kind.task_digestHint" },
  agent_prompt: { label: "auto.kind.agent_prompt", icon: Bot, hint: "auto.kind.agent_promptHint" },
};

const DAYS: StringKey[] = ["auto.day.0", "auto.day.1", "auto.day.2", "auto.day.3", "auto.day.4", "auto.day.5", "auto.day.6"];

const RUN_STATUS: Record<AutomationRun["status"], StringKey> = {
  running: "auto.run.running",
  success: "auto.run.success",
  error: "auto.run.error",
  skipped: "auto.run.skipped",
};

/** The schedule in the UI language (the server's schedule_description is English only). */
function describeScheduleT(spec: ScheduleSpec, t: ReturnType<typeof useT>): string {
  switch (spec.type) {
    case "once":
      return t("auto.desc.once", { at: spec.at.replace("T", " ") });
    case "daily":
      return t("auto.desc.daily", { time: spec.time });
    case "weekly":
      if (spec.days.length === 7) return t("auto.desc.daily", { time: spec.time });
      return t("auto.desc.weekly", { days: [...spec.days].sort().map((d) => t(DAYS[d] ?? "auto.day.0")).join(", "), time: spec.time });
    case "monthly":
      return t("auto.desc.monthly", { day: spec.day, time: spec.time });
    case "interval":
      if (spec.minutes % 60 === 0) return spec.minutes === 60 ? t("auto.desc.hoursOne") : t("auto.desc.hours", { n: spec.minutes / 60 });
      return t("auto.desc.minutes", { n: spec.minutes });
  }
}

export default function AutomationsPage() {
  const t = useT();
  const { data, isLoading, error, refetch } = useAutomations();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Automation | null>(null);
  const tz = data?.timezone ?? "UTC";

  const toggle = useApiMutation(
    (a: Automation) => api(`/automations/${a.id}`, { method: "PATCH", body: { enabled: !a.enabled } }),
    { invalidate: [keys.automations] },
  );
  const remove = useApiMutation((id: string) => api(`/automations/${id}`, { method: "DELETE" }), {
    invalidate: [keys.automations],
    success: t("auto.deleted"),
    onSuccess: () => setDeleting(null),
  });

  const { active, inactive, upcoming } = useMemo(() => {
    const all = data?.automations ?? [];
    return {
      active: all.filter((a) => a.enabled),
      inactive: all.filter((a) => !a.enabled),
      upcoming: all
        .filter((a) => a.enabled && a.next_run)
        .sort((a, b) => a.next_run!.localeCompare(b.next_run!))
        .slice(0, 5),
    };
  }, [data]);

  const row = (a: Automation) => {
    const meta = KIND_META[a.kind];
    const Icon = meta.icon;
    return (
      <li key={a.id} className="flex items-start gap-3 px-4 py-3">
        <div className={cn("mt-0.5 rounded-lg p-2", a.enabled ? "bg-accent-soft text-accent" : "bg-muted text-fg-subtle")}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate font-medium">{a.name}</p>
            {a.status === "failed" && <Badge tone="danger">{t("auto.badge.failed")}</Badge>}
            {a.status === "completed" && <Badge>{t("auto.badge.completed")}</Badge>}
            {a.status === "running" && <Badge tone="accent">{t("auto.badge.running")}</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-fg-muted">{a.schedule ? describeScheduleT(a.schedule, t) : a.schedule_description}</p>
          <p className="mt-0.5 text-xs text-fg-subtle">
            {a.next_run && a.enabled
              ? t("auto.next", { when: formatDateTime(a.next_run, tz) })
              : a.status === "completed"
                ? t("auto.finished")
                : a.enabled
                  ? t("auto.notScheduled")
                  : t("auto.paused")}
            {a.last_run && t("auto.lastRun", { when: relativeTime(a.last_run) })}
            {a.run_count > 0 && (a.run_count === 1 ? t("auto.runsOne") : t("auto.runs", { n: a.run_count }))}
          </p>
          {a.last_error && <p className="mt-1 text-xs text-danger">{a.last_error}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {a.status !== "completed" && (
            <Switch checked={a.enabled} onChange={() => toggle.mutate(a)} label={a.enabled ? t("auto.pause", { name: a.name }) : t("auto.resume", { name: a.name })} />
          )}
          <Button variant="ghost" size="icon" onClick={() => setDeleting(a)} aria-label={t("notes.deleteNamed", { name: a.name })}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </li>
    );
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title={t("nav.automations")}
        description={t("auto.description", { tz })}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> {t("auto.new")}
          </Button>
        }
      />

      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : !data?.automations.length && !data?.runs.length ? (
        <EmptyState
          icon={<CalendarClock className="h-9 w-9" />}
          title={t("auto.empty")}
          action={<Button variant="outline" onClick={() => setCreating(true)}>{t("auto.createReminder")}</Button>}
        >
          {t("auto.emptyHint")}
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {upcoming.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">{t("auto.upcoming")}</h2>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {upcoming.map((a) => (
                  <div key={a.id} className="min-w-44 rounded-xl border border-border bg-surface px-4 py-3">
                    <AlarmClock className="h-4 w-4 text-accent" />
                    <p className="mt-2 truncate text-sm font-medium">{a.name}</p>
                    <p className="text-xs text-fg-subtle">{relativeTime(a.next_run)}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
          {active.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">{t("auto.active")}</h2>
              <Card>
                <ul className="divide-y divide-border">{active.map(row)}</ul>
              </Card>
            </section>
          )}
          {inactive.length > 0 && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">{t("auto.inactive")}</h2>
              <Card>
                <ul className="divide-y divide-border">{inactive.map(row)}</ul>
              </Card>
            </section>
          )}
          <section>
            <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">{t("auto.recent")}</h2>
            {!data?.runs.length ? (
              <p className="text-sm text-fg-subtle">{t("auto.nothingRun")}</p>
            ) : (
              <Card>
                <ul className="divide-y divide-border">
                  {data.runs.slice(0, 20).map((r) => (
                    <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{r.automation_name}</p>
                        <p className={cn("truncate text-xs", r.status === "error" ? "text-danger" : "text-fg-subtle")}>
                          {r.error ?? r.result ?? (r.status === "running" ? t("auto.runningEllipsis") : "")}
                        </p>
                      </div>
                      <div className="shrink-0 text-end">
                        <Badge tone={r.status === "success" ? "success" : r.status === "error" ? "danger" : "neutral"}>{RUN_STATUS[r.status] ? t(RUN_STATUS[r.status]) : r.status}</Badge>
                        <p className="mt-0.5 text-xs text-fg-subtle">{relativeTime(r.started_at)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </section>
          {!!data?.failed_runs.length && (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-danger">{t("auto.failed")}</h2>
              <Card>
                <ul className="divide-y divide-border">
                  {data.failed_runs.map((r) => (
                    <li key={r.id} className="px-4 py-2.5 text-sm">
                      <p className="font-medium">
                        {r.automation_name} <span className="font-normal text-fg-subtle">· {formatDateTime(r.started_at, tz)}</span>
                      </p>
                      <p className="text-xs text-danger">{r.error}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            </section>
          )}
        </div>
      )}

      <AutomationForm open={creating} onClose={() => setCreating(false)} tz={tz} />
      <ConfirmDialog
        open={!!deleting}
        title={t("auto.deleteTitle")}
        message={t("auto.deleteMessage", { name: deleting?.name ?? "" })}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </div>
  );
}

function tomorrowAt9(): string {
  const d = new Date(Date.now() + 86400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`;
}

function AutomationForm({ open, onClose, tz }: { open: boolean; onClose: () => void; tz: string }) {
  const t = useT();
  const [kind, setKind] = useState<AutomationKind>("reminder");
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [type, setType] = useState<ScheduleSpec["type"]>("once");
  const [at, setAt] = useState(tomorrowAt9());
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState<number[]>([1]);
  const [day, setDay] = useState(1);
  const [minutes, setMinutes] = useState(60);

  const schedule: ScheduleSpec =
    type === "once"
      ? { type, at }
      : type === "daily"
        ? { type, time }
        : type === "weekly"
          ? { type, days: days.length ? days : [1], time }
          : type === "monthly"
            ? { type, day, time }
            : { type, minutes };

  const reset = () => {
    setName("");
    setMessage("");
    setKind("reminder");
    setType("once");
    setAt(tomorrowAt9());
  };
  const create = useApiMutation(
    () => api("/automations", { method: "POST", body: { name: name.trim() || message.trim().slice(0, 80) || t(KIND_META[kind].label), kind, message, schedule } }),
    {
      invalidate: [keys.automations],
      success: t("auto.scheduled"),
      onSuccess: () => {
        reset();
        onClose();
      },
    },
  );
  const needsMessage = kind !== "task_digest";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("auto.newTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => create.mutate(undefined)} loading={create.isPending} disabled={needsMessage && !message.trim()}>
            {t("auto.create")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-2">
          {(Object.keys(KIND_META) as AutomationKind[]).map((k) => {
            const Icon = KIND_META[k].icon;
            return (
              <button type="button"
                key={k}
                onClick={() => setKind(k)}
                className={cn(
                  "flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-xs font-medium transition-colors",
                  kind === k ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-muted hover:bg-subtle",
                )}
              >
                <Icon className="h-4 w-4" />
                {t(KIND_META[k].label)}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-fg-subtle">{t(KIND_META[kind].hint)}</p>
        <div>
          <Label htmlFor="auto-name" hint={t("tasks.optional")}>
            {t("auto.name")}
          </Label>
          <Input id="auto-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder={kind === "task_digest" ? t("auto.namePlaceholderDigest") : t("auto.namePlaceholder")} />
        </div>
        {needsMessage && (
          <div>
            <Label htmlFor="auto-message">{kind === "reminder" ? t("auto.reminderMessage") : t("auto.prompt")}</Label>
            <Textarea
              id="auto-message"
              rows={kind === "agent_prompt" ? 3 : 2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={4000}
              placeholder={kind === "reminder" ? t("auto.reminderPlaceholder") : t("auto.promptPlaceholder")}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <Label htmlFor="auto-type">{t("auto.repeat")}</Label>
            <Select id="auto-type" value={type} onChange={(e) => setType(e.target.value as ScheduleSpec["type"])}>
              <option value="once">{t("auto.type.once")}</option>
              <option value="daily">{t("auto.type.daily")}</option>
              <option value="weekly">{t("auto.type.weekly")}</option>
              <option value="monthly">{t("auto.type.monthly")}</option>
              <option value="interval">{t("auto.type.interval")}</option>
            </Select>
          </div>
          <div className="col-span-2 sm:col-span-1">
            {type === "once" ? (
              <>
                <Label htmlFor="auto-at">{t("auto.when")}</Label>
                <Input id="auto-at" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </>
            ) : type === "interval" ? (
              <>
                <Label htmlFor="auto-min">{t("auto.minutes")}</Label>
                <Input id="auto-min" type="number" min={15} max={44640} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
              </>
            ) : (
              <>
                <Label htmlFor="auto-time">{t("auto.time")}</Label>
                <Input id="auto-time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              </>
            )}
          </div>
        </div>
        {type === "weekly" && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("auto.daysOfWeek")}>
            {DAYS.map((d, i) => (
              <button type="button"
                key={d}
                onClick={() => setDays((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))}
                aria-pressed={days.includes(i)}
                className={cn(
                  "h-9 w-11 rounded-lg border text-xs font-medium",
                  days.includes(i) ? "border-accent bg-accent-soft text-accent" : "border-border text-fg-muted",
                )}
              >
                {t(d)}
              </button>
            ))}
          </div>
        )}
        {type === "monthly" && (
          <div>
            <Label htmlFor="auto-day" hint={t("auto.dayOfMonthHint")}>
              {t("auto.dayOfMonth")}
            </Label>
            <Input id="auto-day" type="number" min={1} max={31} value={day} onChange={(e) => setDay(Number(e.target.value))} />
          </div>
        )}
        <p className="rounded-lg bg-subtle px-3 py-2 text-xs text-fg-muted">
          {describeScheduleT(schedule, t)} · {tz}
        </p>
      </div>
    </Dialog>
  );
}
