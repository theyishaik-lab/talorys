import { type FormEvent, useMemo, useState } from "react";
import type { Task, TaskPriority } from "@talorys/shared";
import { TASK_PRIORITIES } from "@talorys/shared/constants";
import { zonedTimeToUtc } from "@talorys/shared/recurrence";
import { CalendarDays, CheckCircle2, Circle, CircleDot, Flag, Plus, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { keys, useApiMutation, useProjects, useTasks, useTimezone } from "../hooks/queries";
import { api } from "../lib/api";
import { type StringKey, useT } from "../lib/i18n";
import { cn, formatDue, toLocalInput } from "../lib/utils";

type Tab = "today" | "upcoming" | "completed";

/** Converts a datetime-local value (owner's timezone) to a UTC ISO string. */
function localInputToIso(value: string, tz: string): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return zonedTimeToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz).toISOString();
}

function endOfLocalDay(tz: string, offsetDays = 0): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  const d = new Date(Date.UTC(+p.year!, +p.month! - 1, +p.day! + offsetDays));
  return zonedTimeToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 23, 59, tz).toISOString();
}

const PRIORITY_TONE: Record<TaskPriority, "neutral" | "accent" | "warning" | "danger"> = {
  low: "neutral",
  medium: "neutral",
  high: "warning",
  urgent: "danger",
};

const TAB_LABELS: Record<Tab, StringKey> = { today: "drawer.today", upcoming: "tasks.tab.upcoming", completed: "tasks.tab.completed" };

const PRIORITY_LABELS: Record<TaskPriority, StringKey> = {
  low: "tasks.priority.low",
  medium: "tasks.priority.medium",
  high: "tasks.priority.high",
  urgent: "tasks.priority.urgent",
};

export default function TasksPage() {
  const t = useT();
  const tz = useTimezone();
  const { data: tasks, isLoading, error, refetch } = useTasks();
  const projects = useProjects();
  const [tab, setTab] = useState<Tab>("today");
  const [editing, setEditing] = useState<Task | null>(null);
  const [quick, setQuick] = useState("");

  const sections = useMemo(() => {
    const todayEnd = endOfLocalDay(tz);
    const open = (tasks ?? []).filter((x) => x.status !== "done");
    return {
      today: open.filter((x) => (x.due_at && x.due_at <= todayEnd) || (!x.due_at && x.status === "in_progress")),
      upcoming: open.filter((x) => !((x.due_at && x.due_at <= todayEnd) || (!x.due_at && x.status === "in_progress"))),
      completed: (tasks ?? []).filter((x) => x.status === "done").sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? "")),
    };
  }, [tasks, tz]);

  const create = useApiMutation(
    (title: string) =>
      api("/tasks", { method: "POST", body: { title, due_at: tab === "today" ? endOfLocalDay(tz) : null } }),
    { invalidate: [keys.tasks], onSuccess: () => setQuick("") },
  );
  const toggle = useApiMutation(
    (task: Task) => api(`/tasks/${task.id}`, { method: "PATCH", body: { status: task.status === "done" ? "todo" : "done" } }),
    { invalidate: [keys.tasks] },
  );

  function submitQuick(e: FormEvent) {
    e.preventDefault();
    if (quick.trim()) create.mutate(quick.trim());
  }

  const list = sections[tab];
  const projectName = (id: string | null) => projects.data?.find((p) => p.id === id)?.name;
  const nowIso = new Date().toISOString();

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader title={t("nav.tasks")} description={t("tasks.description")} />

      <div role="tablist" className="mb-5 flex gap-1 rounded-lg bg-muted p-1">
        {(["today", "upcoming", "completed"] as Tab[]).map((key) => (
          <button type="button"
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              tab === key ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg",
            )}
          >
            {t(TAB_LABELS[key])}
            <span className="ms-1.5 text-xs text-fg-subtle">{sections[key].length}</span>
          </button>
        ))}
      </div>

      {tab !== "completed" && (
        <form onSubmit={submitQuick} className="mb-4 flex gap-2">
          <Input
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder={tab === "today" ? t("tasks.addToday") : t("tasks.addPlaceholder")}
            maxLength={300}
            aria-label={t("tasks.newTitle")}
          />
          <Button type="submit" loading={create.isPending} disabled={!quick.trim()} aria-label={t("tasks.add")}>
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">{t("tasks.addShort")}</span>
          </Button>
        </form>
      )}

      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : list.length === 0 ? (
        <EmptyState icon={<CheckCircle2 className="h-9 w-9" />} title={tab === "completed" ? t("tasks.empty.completed") : t("tasks.empty.clear")}>
          {tab === "today" ? t("tasks.empty.today") : tab === "upcoming" ? t("tasks.empty.upcoming") : t("tasks.empty.completedHint")}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
          {list.map((task) => {
            const overdue = task.status !== "done" && task.due_at && task.due_at < nowIso;
            return (
              <li key={task.id} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-subtle">
                <button type="button"
                  onClick={() => toggle.mutate(task)}
                  className="mt-0.5 text-fg-subtle transition-colors hover:text-accent"
                  aria-label={task.status === "done" ? t("tasks.markUndone", { title: task.title }) : t("tasks.complete", { title: task.title })}
                >
                  {task.status === "done" ? (
                    <CheckCircle2 className="h-5 w-5 text-accent" />
                  ) : task.status === "in_progress" ? (
                    <CircleDot className="h-5 w-5" />
                  ) : (
                    <Circle className="h-5 w-5" />
                  )}
                </button>
                <button type="button" onClick={() => setEditing(task)} className="min-w-0 flex-1 text-start">
                  <p className={cn("text-[15px] leading-6", task.status === "done" && "text-fg-subtle line-through")} dir="auto">{task.title}</p>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-subtle">
                    {task.due_at && (
                      <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-danger")}>
                        <CalendarDays className="h-3 w-3" />
                        {overdue ? t("tasks.overdue") : ""}
                        {formatDue(task.due_at, tz)}
                      </span>
                    )}
                    {projectName(task.project_id) && <span>{projectName(task.project_id)}</span>}
                    {task.description && <span className="max-w-[16rem] truncate">{task.description}</span>}
                  </div>
                </button>
                {(task.priority === "high" || task.priority === "urgent") && task.status !== "done" && (
                  <Badge tone={PRIORITY_TONE[task.priority]} className="mt-0.5">
                    <Flag className="me-1 h-3 w-3" />
                    {t(PRIORITY_LABELS[task.priority])}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <TaskEditor task={editing} onClose={() => setEditing(null)} tz={tz} />
    </div>
  );
}

function TaskEditor({ task, onClose, tz }: { task: Task | null; onClose: () => void; tz: string }) {
  const t = useT();
  const projects = useProjects();
  const [form, setForm] = useState({ title: "", description: "", priority: "medium" as TaskPriority, status: "todo" as Task["status"], due: "", project_id: "" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lastId, setLastId] = useState<string | null>(null);
  if (task && task.id !== lastId) {
    setLastId(task.id);
    setForm({
      title: task.title,
      description: task.description,
      priority: task.priority,
      status: task.status,
      due: toLocalInput(task.due_at, tz),
      project_id: task.project_id ?? "",
    });
  }
  const close = () => {
    setLastId(null);
    onClose();
  };
  const save = useApiMutation(
    () =>
      api(`/tasks/${task!.id}`, {
        method: "PATCH",
        body: {
          title: form.title,
          description: form.description,
          priority: form.priority,
          status: form.status,
          due_at: localInputToIso(form.due, tz),
          project_id: form.project_id || null,
        },
      }),
    { invalidate: [keys.tasks], success: t("tasks.saved"), onSuccess: close },
  );
  const remove = useApiMutation(() => api(`/tasks/${task!.id}`, { method: "DELETE" }), {
    invalidate: [keys.tasks],
    success: t("tasks.deleted"),
    onSuccess: () => {
      setConfirmDelete(false);
      close();
    },
  });

  return (
    <>
      <Dialog
        open={!!task && !confirmDelete}
        onClose={close}
        title={t("tasks.edit")}
        footer={
          <div className="flex w-full justify-between">
            <Button variant="ghost" className="text-danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" /> {t("common.delete")}
            </Button>
            <div className="flex gap-2">
              <Button variant="ghost" onClick={close}>
                {t("common.cancel")}
              </Button>
              <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!form.title.trim()}>
                {t("common.save")}
              </Button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="task-title">{t("chat.title")}</Label>
            <Input id="task-title" dir="auto" value={form.title} maxLength={300} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div>
            <Label htmlFor="task-desc">{t("tasks.field.notes")}</Label>
            <Textarea id="task-desc" dir="auto" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="task-status">{t("push.state.title")}</Label>
              <Select id="task-status" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as Task["status"] })}>
                <option value="todo">{t("tasks.status.todo")}</option>
                <option value="in_progress">{t("tasks.status.in_progress")}</option>
                <option value="done">{t("tasks.status.done")}</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="task-priority">{t("tasks.field.priority")}</Label>
              <Select id="task-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}>
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {t(PRIORITY_LABELS[p])}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="task-due" hint={tz}>
                {t("tasks.field.due")}
              </Label>
              <Input id="task-due" type="datetime-local" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="task-project" hint={t("tasks.optional")}>
                {t("tasks.field.project")}
              </Label>
              <Select id="task-project" value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
                <option value="">{t("tasks.none")}</option>
                {projects.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        title={t("tasks.deleteTitle")}
        message={t("tasks.deleteMessage", { title: task?.title ?? "" })}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate(undefined)}
        loading={remove.isPending}
      />
    </>
  );
}
