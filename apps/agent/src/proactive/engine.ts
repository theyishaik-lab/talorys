import type { Settings, Task } from "@talorys/shared";
import type { Services } from "../services/container";
import { formatLocal, localDayBounds } from "../services/time";

export interface ScanResult {
  status: "success" | "skipped";
  result: string;
}

const PRIORITY_WEIGHT: Record<string, number> = { urgent: 30, high: 20, medium: 10, low: 5 };

/** The owner-local hour (0–23) right now, for quiet-hours checks. */
function localHour(timezone: string, at = new Date()): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", hour12: false }).format(at);
  const n = Number.parseInt(h, 10);
  return Number.isFinite(n) ? n % 24 : at.getUTCHours();
}

/** True when `hour` falls in the quiet window [start, end) with wrap-around past midnight. */
export function inQuietHours(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Phase 1 proactive scan: no AI. Turns task signals (overdue, due today) into suggestions
 * and surfaces a single summary notification. Scheduled runs only ever *propose*; nothing
 * here commits a destructive action.
 */
export function runProactiveScan(services: Services, settings: Settings = services.settings.get()): ScanResult {
  const p = settings.proactive;
  if (!p.enabled) return { status: "skipped", result: "Proactive engine is off" };

  const hour = localHour(settings.timezone);
  if (inQuietHours(hour, p.quietStartHour, p.quietEndHour)) {
    return { status: "skipped", result: `Quiet hours (local hour ${hour})` };
  }

  const suggestions = services.suggestions;
  suggestions.expireStale();

  const bounds = localDayBounds(settings.timezone);
  const overdue = services.tasks.list({ view: "overdue", limit: 50 });
  const today = services.tasks
    .list({ view: "today", dayStart: bounds.start, dayEnd: bounds.end, limit: 50 })
    .filter((t) => !overdue.some((o) => o.id === t.id));

  const candidates: { kind: "reminder"; title: string; body: string; signalHash: string; score: number }[] = [];
  const due = (t: Task) => (t.due_at ? ` (due ${formatLocal(t.due_at, settings.timezone)})` : "");
  for (const t of overdue) {
    candidates.push({
      kind: "reminder",
      title: `Overdue: ${t.title}`,
      body: `This task is overdue${due(t)}. Want to reschedule it or mark it done?`,
      signalHash: `task-overdue:${t.id}`,
      score: 100 + (PRIORITY_WEIGHT[t.priority] ?? 0),
    });
  }
  for (const t of today) {
    candidates.push({
      kind: "reminder",
      title: `Due today: ${t.title}`,
      body: `This task is due today${due(t)}.`,
      signalHash: `task-today:${t.id}:${t.due_at ?? ""}`,
      score: 50 + (PRIORITY_WEIGHT[t.priority] ?? 0),
    });
  }

  candidates.sort((a, b) => b.score - a.score);

  let created = 0;
  for (const c of candidates.slice(0, p.maxPerRun)) {
    if (suggestions.create(c)) created++;
  }

  if (created > 0) {
    services.notifications.create({
      title: "New suggestions",
      body: created === 1 ? "You have 1 new suggestion." : `You have ${created} new suggestions.`,
    });
  }

  return {
    status: "success",
    result: `${created} new suggestion(s) from ${overdue.length} overdue, ${today.length} due today`,
  };
}
