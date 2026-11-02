import { useEffect, useMemo, useState } from "react";
import type { Memory, MemoryCategory, MemoryDreamRun, MemoryReview, MemoryReviewAction } from "@talorys/shared";
import { MEMORY_CATEGORIES } from "@talorys/shared/constants";
import { Archive, ArchiveRestore, Brain, Clock, GitCompare, Moon, Pencil, Pin, PinOff, Plus, RefreshCw, Search, Trash2, Undo2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { type MemoryStatusFilter, useApiMutation, useDreaming, useMemories, useMemoryHistory, useMemoryReviews, usePinnedMemories } from "../hooks/queries";
import { useToast } from "../hooks/toast";
import { api } from "../lib/api";
import { type StringKey, useT } from "../lib/i18n";
import { cn, relativeTime } from "../lib/utils";

const CATEGORY_LABELS: Record<MemoryCategory, StringKey> = {
  preference: "memory.cat.preference",
  fact: "memory.cat.fact",
  goal: "memory.cat.goal",
  project: "memory.cat.project",
  habit: "memory.cat.habit",
  person: "memory.cat.person",
  other: "memory.cat.other",
};

const FILTERS: { value: MemoryStatusFilter; label: StringKey }[] = [
  { value: "all", label: "memory.filter.all" },
  { value: "active", label: "memory.filter.active" },
  { value: "historical", label: "memory.filter.historical" },
  { value: "review", label: "memory.filter.review" },
];

interface WriteResponse {
  memory: Memory;
  superseded?: Memory[];
  reviews?: number;
}

/** Explains what Smart Memory did with a save, in plain words. */
function writeMessage(r: WriteResponse, t: ReturnType<typeof useT>): string {
  const parts = [t("memory.saved")];
  if (r.superseded?.length) parts.push(r.superseded.length === 1 ? t("memory.supersededOne") : t("memory.supersededMany", { n: r.superseded.length }));
  if (r.reviews) parts.push(t("memory.mayConflict"));
  return parts.join(" · ");
}

const SOURCE_KEYS: Record<Memory["source"], StringKey> = {
  agent: "memory.source.agent",
  import: "memory.source.import",
  manual: "memory.source.manual",
  dream: "memory.source.dream",
};
const sourceKey = (m: Memory): StringKey => SOURCE_KEYS[m.source] ?? "memory.source.manual";

export default function MemoryPage() {
  const t = useT();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState<MemoryStatusFilter>("all");
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const { data, isLoading, error, refetch } = useMemories(debounced || undefined, filter);
  const reviews = useMemoryReviews();
  const [editing, setEditing] = useState<Memory | "new" | null>(null);
  const [correcting, setCorrecting] = useState<Memory | null>(null);
  const [historyOf, setHistoryOf] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<MemoryCategory, Memory[]>();
    for (const m of data?.memories ?? []) {
      const list = map.get(m.category) ?? [];
      list.push(m);
      map.set(m.category, list);
    }
    return MEMORY_CATEGORIES.filter((c) => map.has(c)).map((c) => [c, map.get(c)!] as const);
  }, [data]);

  const remove = useApiMutation((id: string) => api(`/memories/${id}`, { method: "DELETE" }), {
    invalidate: [["memories"]],
    success: t("memory.deleted"),
    onSuccess: () => setDeleting(null),
  });
  const setStatus = useApiMutation(
    ({ id, status }: { id: string; status: Memory["status"] }) => api(`/memories/${id}/status`, { method: "POST", body: { status } }),
    {
      invalidate: [["memories"]],
      success: t("memory.updated"),
    },
  );

  const pin = useApiMutation(
    ({ id, pinned }: { id: string; pinned: boolean }) => api(`/memories/${id}/pin`, { method: "POST", body: { pinned } }),
    { invalidate: [["memories"]] },
  );

  const reviewList = reviews.data ?? [];
  const counts = data?.counts;

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title={t("nav.memory")}
        description={
          <>
            {t("memory.description")}
            {data ? ` ${t("memory.total", { n: data.total })}` : ""}
          </>
        }
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> {t("memory.add")}
          </Button>
        }
      />
      <div className="mb-4 flex gap-1 overflow-x-auto rounded-lg bg-muted p-1" role="tablist" aria-label={t("memory.statusTabs")}>
        {FILTERS.map((f) => {
          const count = f.value === "active" ? counts?.active : f.value === "historical" ? counts?.historical : f.value === "review" ? counts?.review : undefined;
          return (
            <button
              type="button"
              key={f.value}
              role="tab"
              aria-selected={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "flex-1 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium",
                filter === f.value ? "bg-surface shadow-sm" : "text-fg-muted hover:text-fg",
              )}
            >
              {t(f.label)}
              {count ? <span className="ms-1 text-fg-subtle">{count}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="relative mb-6">
        <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("memory.search")} className="ps-9" dir="auto" aria-label={t("memory.search")} />
      </div>

      {filter === "all" && !debounced && (
        <>
          <CorePanel onUnpin={(id) => pin.mutate({ id, pinned: false })} />
          <LearnedPanel />
        </>
      )}

      {(filter === "review" || filter === "all") && reviewList.length > 0 && <ReviewPanel reviews={reviewList} />}

      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : grouped.length === 0 ? (
        filter === "review" && reviewList.length > 0 ? null : (
          <EmptyState
            icon={<Brain className="h-9 w-9" />}
            title={debounced ? t("memory.empty.noMatch") : filter === "all" ? t("memory.empty.none") : t("memory.empty.here")}
            action={!debounced && filter === "all" && <Button variant="outline" onClick={() => setEditing("new")}>{t("memory.addFirst")}</Button>}
          >
            {debounced
              ? t("memory.empty.tryOther")
              : filter === "historical"
                ? t("memory.empty.historical")
                : filter === "review"
                  ? t("memory.empty.review")
                  : filter === "active"
                    ? t("memory.empty.active")
                    : t("memory.empty.hint")}
          </EmptyState>
        )
      ) : (
        <div className="space-y-8">
          {grouped.map(([category, items]) => (
            <section key={category}>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
                {t(CATEGORY_LABELS[category])} <span className="ms-1 normal-case tracking-normal">· {items.length}</span>
              </h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                {items.map((m) => (
                  <li key={m.id} className="group flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-[15px] leading-6", m.status === "historical" && "text-fg-muted")} dir="auto">
                        {m.content}
                        {m.status === "historical" && <Badge className="ms-2 align-middle">{t("memory.badge.past")}</Badge>}
                        {m.status === "uncertain" && <Badge tone="warning" className="ms-2 align-middle">{t("memory.badge.unsure")}</Badge>}
                        {m.pinned && <Pin className="ms-2 inline h-3.5 w-3.5 align-middle text-accent" aria-label={t("memory.core")} />}
                      </p>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {t(sourceKey(m))} · {relativeTime(m.updated_at)}
                        {m.valid_from && t("memory.since", { date: m.valid_from })}
                        {m.valid_until && t("memory.until", { date: m.valid_until })}
                        {m.superseded_by && (
                          <>
                            {" · "}
                            <button type="button" className="text-accent hover:underline" onClick={() => setHistoryOf(m)}>
                              {t("memory.replacedBy")}
                            </button>
                          </>
                        )}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                      {m.status !== "historical" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => pin.mutate({ id: m.id, pinned: !m.pinned })}
                          aria-label={m.pinned ? t("memory.unpin") : t("memory.pin")}
                          title={m.pinned ? t("memory.unpin") : t("memory.pin")}
                          aria-pressed={m.pinned}
                        >
                          {m.pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => setHistoryOf(m)} aria-label={t("ai.memoryHistory")} title={t("memory.historyShort")}>
                        <Clock className="h-4 w-4" />
                      </Button>
                      {m.status !== "historical" && (
                        <Button variant="ghost" size="icon" onClick={() => setCorrecting(m)} aria-label={t("memory.updateFact")} title={t("memory.updateFactTitle")}>
                          <RefreshCw className="h-4 w-4" />
                        </Button>
                      )}
                      {m.status === "historical" ? (
                        <Button variant="ghost" size="icon" onClick={() => setStatus.mutate({ id: m.id, status: "active" })} aria-label={t("memory.restore")} title={t("memory.restore")}>
                          <ArchiveRestore className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button variant="ghost" size="icon" onClick={() => setStatus.mutate({ id: m.id, status: "historical" })} aria-label={t("memory.markPast")} title={t("memory.markPastTitle")}>
                          <Archive className="h-4 w-4" />
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" onClick={() => setEditing(m)} aria-label={t("memory.edit")} title={t("memory.editShort")}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleting(m)} aria-label={t("memory.delete")} title={t("common.delete")}>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <MemoryEditor memory={editing} onClose={() => setEditing(null)} />
      <CorrectDialog memory={correcting} onClose={() => setCorrecting(null)} />
      <HistoryDialog memory={historyOf} onClose={() => setHistoryOf(null)} />
      <ConfirmDialog
        open={!!deleting}
        title={t("memory.forgetTitle")}
        message={t("memory.forgetMessage", { content: deleting?.content ?? "" })}
        confirmLabel={t("memory.forget")}
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </div>
  );
}

/** Pinned core memory: always in the prompt; changed only here (or by an explicit "always remember"). */
function CorePanel({ onUnpin }: { onUnpin: (id: string) => void }) {
  const t = useT();
  const { data } = usePinnedMemories();
  if (!data) return null;
  const u = data.usage;
  return (
    <section className="mb-8" aria-label={t("memory.core")}>
      <h2 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-fg-subtle">
        <Pin className="h-3.5 w-3.5" /> {t("memory.core")}
        <span className="ms-auto normal-case tracking-normal">{t("memory.coreUsage", { items: u.items, maxItems: u.maxItems, chars: u.chars, maxChars: u.maxChars })}</span>
      </h2>
      <p className="mb-2 text-xs text-fg-subtle">{data.memories.length ? t("memory.coreHint") : t("memory.coreEmpty")}</p>
      {data.memories.length > 0 && (
        <ul className="divide-y divide-border rounded-xl border border-accent/40 bg-surface">
          {data.memories.map((m) => (
            <li key={m.id} className="flex items-start gap-3 px-4 py-2.5">
              <p className="min-w-0 flex-1 text-[15px] leading-6" dir="auto">
                {m.content}
              </p>
              <Button variant="ghost" size="icon" onClick={() => onUnpin(m.id)} aria-label={t("memory.unpin")} title={t("memory.unpin")}>
                <PinOff className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** "What was learned": the latest nightly passes, each change with an Undo. */
function LearnedPanel() {
  const t = useT();
  const toast = useToast();
  const { data } = useDreaming();
  const run = useApiMutation(() => api<{ run: MemoryDreamRun }>("/memories/dreaming/run", { method: "POST" }), {
    invalidate: [["memories"]],
    onSuccess: ({ run: r }) =>
      toast(
        r.status === "success"
          ? t("memory.runDone", { n: r.applied })
          : r.status === "failed"
            ? t("memory.runFailed", { error: r.error ?? r.summary })
            : t("memory.runSkipped", { summary: r.summary }),
      ),
  });
  const undo = useApiMutation(
    ({ id, index }: { id: string; index: number }) => api(`/memories/dreaming/runs/${id}/undo`, { method: "POST", body: { index } }),
    { invalidate: [["memories"]], success: t("memory.undone") },
  );
  if (!data) return null;
  const changes = data.runs.flatMap((r) => r.changes.map((c, index) => ({ run: r, c, index })));
  const rejected = data.runs.reduce((n, r) => n + r.rejected, 0);
  return (
    <section className="mb-8" aria-label={t("memory.learned")}>
      <h2 className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-fg-subtle">
        <Moon className="h-3.5 w-3.5" /> {t("memory.learned")}
        <Button size="sm" variant="ghost" className="ms-auto normal-case tracking-normal" onClick={() => run.mutate(undefined)} loading={run.isPending}>
          {t("memory.runNow")}
        </Button>
      </h2>
      <p className="mb-2 text-xs text-fg-subtle">
        {data.enabled ? t("memory.learnedHint") : t("memory.dreamingOff")}
        {data.enabled && data.next_run ? ` ${t("memory.nextRun", { when: relativeTime(data.next_run) })}` : ""}
      </p>
      {changes.length === 0 ? (
        <p className="text-sm text-fg-muted">{data.runs[0]?.summary || t("memory.learnedEmpty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
          {changes.slice(0, 20).map(({ run: r, c, index }) => (
            <li key={`${r.id}:${index}`} className={cn("flex items-start gap-3 px-4 py-2.5", c.undone && "opacity-50")}>
              <div className="min-w-0 flex-1">
                <p className={cn("text-[15px] leading-6", c.undone && "line-through")} dir="auto">
                  {c.content}
                </p>
                <p className="text-xs text-fg-subtle" dir="auto">
                  {t(c.type === "added" ? "memory.change.added" : "memory.change.marked_past")} · {relativeTime(r.started_at)}
                  {c.reason ? ` · ${c.reason}` : ""}
                </p>
              </div>
              {!c.undone && (
                <Button variant="ghost" size="icon" onClick={() => undo.mutate({ id: r.id, index })} aria-label={t("memory.undo")} title={t("memory.undo")}>
                  <Undo2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {rejected > 0 && <p className="mt-1 text-xs text-fg-subtle">{t("memory.rejectedN", { n: rejected })}</p>}
    </section>
  );
}

function ReviewPanel({ reviews }: { reviews: MemoryReview[] }) {
  const t = useT();
  const resolve = useApiMutation(
    ({ id, action }: { id: string; action: MemoryReviewAction }) => api(`/memories/reviews/${id}`, { method: "POST", body: { action } }),
    { invalidate: [["memories"]], success: t("memory.done") },
  );
  return (
    <section className="mb-8 space-y-2" aria-label={t("memory.conflicts")}>
      <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-fg-subtle">
        <GitCompare className="h-3.5 w-3.5" /> {t("memory.conflicts")} · {reviews.length}
      </h2>
      {reviews.map((r) => (
        <div key={r.id} className="rounded-xl border border-warning/40 bg-surface px-4 py-3">
          <p className="text-xs text-fg-subtle">{r.reason}</p>
          <dl className="mt-2 grid gap-1 text-sm">
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-fg-subtle">{t("memory.newer")}</dt>
              <dd>{r.memory.content}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-16 shrink-0 text-fg-subtle">{t("memory.older")}</dt>
              <dd>{r.other.content}</dd>
            </div>
          </dl>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => resolve.mutate({ id: r.id, action: "keep_both" })}>
              {t("memory.keepBoth")}
            </Button>
            <Button size="sm" onClick={() => resolve.mutate({ id: r.id, action: "mark_historical" })}>
              {t("memory.markOlderPast")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => resolve.mutate({ id: r.id, action: "replace" })}>
              {t("memory.replaceOlder")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: r.id, action: "cancel" })}>
              {t("memory.discardNewer")}
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}

function HistoryDialog({ memory, onClose }: { memory: Memory | null; onClose: () => void }) {
  const t = useT();
  const { data, isLoading } = useMemoryHistory(memory?.id ?? null);
  const current = data ? (data.next.at(-1) ?? data.memory) : null;
  const earlier = data ? [...data.previous, ...(data.next.length ? [data.memory, ...data.next.slice(0, -1)] : [])].reverse() : [];
  return (
    <Dialog open={!!memory} onClose={onClose} title={t("ai.memoryHistory")}>
      {isLoading || !data || !current ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">{current.status === "historical" ? t("memory.latest") : t("memory.current")}</p>
            <p className="mt-1 leading-6">“{current.content}”</p>
            <p className="text-xs text-fg-subtle">
              {t("memory.savedAgo", { when: relativeTime(current.created_at) })}
              {current.valid_from && t("memory.since", { date: current.valid_from })}
            </p>
          </div>
          {earlier.length > 0 ? (
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">{t("memory.previously")}</p>
              <ul className="mt-1 space-y-2">
                {earlier.map((m) => (
                  <li key={m.id} className="text-fg-muted">
                    “{m.content}”
                    <span className="block text-xs text-fg-subtle">
                      {t("memory.savedAgo", { when: relativeTime(m.created_at) })}
                      {m.valid_until && t("memory.until", { date: m.valid_until })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-fg-subtle">{t("memory.noEarlier")}</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** Saves a newer version of a fact; the old one is kept as history. */
function CorrectDialog({ memory, onClose }: { memory: Memory | null; onClose: () => void }) {
  const t = useT();
  const [content, setContent] = useState("");
  const toast = useToast();
  useEffect(() => setContent(memory?.content ?? ""), [memory]);
  const save = useApiMutation(() => api<WriteResponse>(`/memories/${memory!.id}/correct`, { method: "POST", body: { content } }), {
    invalidate: [["memories"]],
    onSuccess: (r) => {
      toast(writeMessage(r, t));
      onClose();
    },
  });
  return (
    <Dialog
      open={!!memory}
      onClose={onClose}
      title={t("memory.updateFact")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!content.trim() || content.trim() === memory?.content}>
            {t("memory.saveNewVersion")}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-fg-muted">
          {t("memory.correctHint", { content: memory?.content ?? "" })}
        </p>
        <div>
          <Label htmlFor="memory-correct">{t("memory.trueNow")}</Label>
          <Textarea id="memory-correct" dir="auto" rows={3} value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} autoFocus />
        </div>
      </div>
    </Dialog>
  );
}

function MemoryEditor({ memory, onClose }: { memory: Memory | "new" | null; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("other");
  const toast = useToast();
  const t = useT();
  useEffect(() => {
    if (memory && memory !== "new") {
      setContent(memory.content);
      setCategory(memory.category);
    } else {
      setContent("");
      setCategory("preference");
    }
  }, [memory]);
  const save = useApiMutation(
    () =>
      memory === "new"
        ? api<WriteResponse>("/memories", { method: "POST", body: { content, category } })
        : api<WriteResponse>(`/memories/${(memory as Memory).id}`, { method: "PATCH", body: { content, category } }),
    {
      invalidate: [["memories"]],
      onSuccess: (r) => {
        toast(writeMessage(r, t));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open={!!memory}
      onClose={onClose}
      title={memory === "new" ? t("memory.add") : t("memory.edit")}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!content.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="memory-content">{t("memory.whatRemember")}</Label>
          <Textarea id="memory-content" dir="auto" rows={3} value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} autoFocus placeholder={t("memory.placeholder")} />
          {memory !== "new" && memory && (
            <p className="mt-1 text-xs text-fg-subtle">{t("memory.typoHint")}</p>
          )}
        </div>
        <div>
          <Label htmlFor="memory-category">{t("memory.category")}</Label>
          <Select id="memory-category" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)}>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(CATEGORY_LABELS[c])}
              </option>
            ))}
          </Select>
        </div>
        <Badge tone="accent">{t("memory.storedOnly")}</Badge>
      </div>
    </Dialog>
  );
}
