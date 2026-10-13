import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type AiProviderId,
  type ChainRef,
  type ChainStatus,
  type ChainStatusEntry,
  endpointIdFromName,
  MAX_FALLBACK_CHAIN,
  modelLabel,
  moveItem,
  type Settings,
  settingsPatchForChain,
} from "@talorys/shared";
import { ChevronDown, ChevronUp, GripVertical, Plus, RefreshCw, RotateCcw, Server, Trash2 } from "lucide-react";
import { createPortal } from "react-dom";
import { type ComponentType, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { keys as queryKeys, useApiMutation } from "../hooks/queries";
import { errorMessage, useToast } from "../hooks/toast";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { providerLabel } from "../lib/provider-label";
import { quotaLine, stateText } from "../lib/chain-view";
import { cn } from "../lib/utils";
import type { CatalogResponse } from "./ModelPicker";
import { Badge, Button, Dialog, Input, Select, Spinner, Switch } from "./ui";

type SectionProps = { title?: string; children: ReactNode; inset?: boolean };
type RowProps = { label: string; hint?: ReactNode; children: ReactNode };

export const CHAIN_STATUS_KEY = ["ai", "chain"] as const;
const ENDPOINTS_KEY = ["ai", "endpoints"] as const;
/** The chosen model, the selected backup, then up to MAX_FALLBACK_CHAIN more. */
const MAX_ENTRIES = MAX_FALLBACK_CHAIN + 2;

interface EndpointInfo {
  id: string;
  name: string;
  baseURL: string;
  key: { set: boolean; hint: string | null };
}

const refKey = (r: ChainRef) => `${r.provider}|${r.model}`;



const STATE_DOT: Record<ChainStatusEntry["state"], string> = {
  available: "bg-success",
  paused: "bg-warning",
  exhausted: "bg-danger",
  not_configured: "bg-fg-subtle",
};

/**
 * Settings → Model → "Model chain": the whole fallback chain in order with each model's live state
 * (available / paused until … / daily quota used up / not set up) and what is left where the provider
 * says. Reorder (drag the grip or the arrows), remove, add a model from any provider or a new
 * OpenAI-compatible endpoint; "Save order" writes it with PATCH /api/settings.
 */
export function ChainEditor({ settings, catalog, Section, Row }: { settings: Settings; catalog: CatalogResponse; Section: ComponentType<SectionProps>; Row: ComponentType<RowProps> }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: CHAIN_STATUS_KEY, queryFn: () => api<ChainStatus>("/ai/chain"), refetchInterval: 60_000, staleTime: 15_000 });
  const endpoints = useQuery({ queryKey: ENDPOINTS_KEY, queryFn: () => api<{ endpoints: EndpointInfo[] }>("/ai/endpoints").then((r) => r.endpoints) });
  const stored = useMemo(() => (status.data?.entries ?? []).map((e) => ({ provider: e.provider, model: e.model })), [status.data]);
  const [draft, setDraft] = useState<ChainRef[] | null>(null);
  const list = draft ?? stored;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);
  const [picker, setPicker] = useState(false);
  const [endpointForm, setEndpointForm] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const byKey = useMemo(() => new Map((status.data?.entries ?? []).map((e) => [refKey(e), e])), [status.data]);

  const save = useApiMutation((refs: ChainRef[]) => api<{ settings: Settings }>("/settings", { method: "PATCH", body: settingsPatchForChain(refs) }), {
    success: t("chain.saved"),
    onSuccess: (r) => {
      qc.setQueryData(queryKeys.settings, r.settings);
      setDraft(null);
      void qc.invalidateQueries({ queryKey: CHAIN_STATUS_KEY });
      void qc.invalidateQueries({ queryKey: ["ai", "models"] });
    },
  });
  const toggle = useApiMutation((enabled: boolean) => api<{ settings: Settings }>("/settings", { method: "PATCH", body: { fallback: { enabled } } }), {
    success: t("settings.saved"),
    onSuccess: (r) => {
      qc.setQueryData(queryKeys.settings, r.settings);
      void qc.invalidateQueries({ queryKey: CHAIN_STATUS_KEY });
    },
  });
  const clearPauses = useApiMutation(() => api("/ai/cooldowns", { method: "DELETE" }), {
    success: t("chain.cleared"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: CHAIN_STATUS_KEY }),
  });

  const edit = (next: ChainRef[]) => setDraft(next);
  const add = (ref: ChainRef) => {
    if (list.some((r) => refKey(r) === refKey(ref))) return;
    if (list.length >= MAX_ENTRIES) {
      toast(t("chain.full", { n: MAX_ENTRIES }), "error");
      return;
    }
    edit([...list, ref]);
  };

  const anyPaused = (status.data?.entries ?? []).some((e) => e.state === "paused" || e.state === "exhausted");

  return (
    <Section title={t("chain.title")}>
      <Row label={t("chain.enable")} hint={t("chain.hint")}>
        <div className="flex justify-end">
          <Switch checked={settings.fallback.enabled} onChange={(v) => toggle.mutate(v)} label={t("chain.enable")} />
        </div>
      </Row>
      {!settings.fallback.enabled && <p className="px-4 pb-2 text-[12.5px] text-warning">{t("chain.off")}</p>}

      {status.isLoading ? (
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      ) : status.error ? (
        <p className="px-4 py-3 text-sm text-danger">{t("chain.loadError", { error: errorMessage(status.error) })}</p>
      ) : (
        <ChainList
          list={list}
          byKey={byKey}
          enabled={settings.fallback.enabled}
          onMove={(from, to) => edit(moveItem(list, from, to))}
          onRemove={(i) => (list.length <= 1 ? toast(t("chain.empty"), "error") : edit(list.filter((_, j) => j !== i)))}
        />
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3">
        <Button variant="outline" size="sm" onClick={() => setPicker(true)} disabled={list.length >= MAX_ENTRIES}>
          <Plus className="h-4 w-4" /> {t("chain.add")}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setEndpointForm(true)} disabled={list.length >= MAX_ENTRIES}>
          <Server className="h-4 w-4" /> {t("chain.addEndpoint")}
        </Button>
        <span className="flex-1" />
        {anyPaused && !dirty && (
          <Button variant="ghost" size="sm" onClick={() => clearPauses.mutate(undefined)} disabled={clearPauses.isPending}>
            <RotateCcw className="h-4 w-4" /> {t("chain.clearPauses")}
          </Button>
        )}
        {!dirty && (
          <Button variant="ghost" size="sm" onClick={() => void status.refetch()} disabled={status.isFetching} aria-label={t("chain.refresh")}>
            <RefreshCw className={cn("h-4 w-4", status.isFetching && "animate-spin")} />
          </Button>
        )}
      </div>

      {dirty &&
        createPortal(
          <div
            className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-30 mx-auto flex max-w-xl items-center gap-2 rounded-2xl border border-border bg-surface/95 px-4 py-3 shadow-card backdrop-blur"
            data-testid="chain-save-bar"
          >
            <span className="flex-1 text-[13px] text-fg-muted">{t("chain.unsaved")}</span>
            <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>
              {t("chain.discard")}
            </Button>
            <Button size="sm" loading={save.isPending} onClick={() => save.mutate(list)}>
              {t("chain.save")}
            </Button>
          </div>,
          document.body,
        )}

      <AddModelDialog open={picker} onClose={() => setPicker(false)} catalog={catalog} endpoints={endpoints.data ?? []} list={list} onAdd={(r) => add(r)} />
      <AddEndpointDialog
        open={endpointForm}
        onClose={() => setEndpointForm(false)}
        taken={(endpoints.data ?? []).map((e) => e.id)}
        onAdded={(ref, name) => {
          void qc.invalidateQueries({ queryKey: ENDPOINTS_KEY });
          add(ref);
          toast(t("chain.ep.saved", { name }));
        }}
      />
    </Section>
  );
}

function ChainList({
  list,
  byKey,
  enabled,
  onMove,
  onRemove,
}: {
  list: ChainRef[];
  byKey: Map<string, ChainStatusEntry>;
  enabled: boolean;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
}) {
  const t = useT();
  const rows = useRef<(HTMLLIElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; over: number; pointer: number } | null>(null);

  // Pointer-based drag (mouse and touch alike): the row under the finger is the drop target.
  const targetAt = (y: number) => {
    let target = list.length - 1;
    for (let i = 0; i < rows.current.length; i++) {
      const el = rows.current[i];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        target = i;
        break;
      }
    }
    return target;
  };
  const onDown = (i: number) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ from: i, over: i, pointer: e.pointerId });
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const over = targetAt(e.clientY);
    if (over !== drag.over) setDrag({ ...drag, over });
  };
  const onUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (drag.over !== drag.from) onMove(drag.from, drag.over);
    setDrag(null);
  };

  return (
    <ol className="divide-y divide-border/60" aria-label={t("chain.title")} data-testid="chain-list">
      {list.map((ref, i) => {
        const e = byKey.get(refKey(ref));
        const state = e?.state ?? "available";
        const dimmed = !enabled && i > 0;
        return (
          <li
            key={refKey(ref)}
            ref={(el) => {
              rows.current[i] = el;
            }}
            className={cn(
              "flex items-start gap-2 px-3 py-3 transition-colors",
              drag?.from === i && "bg-subtle",
              drag && drag.over === i && drag.from !== i && "border-t-2 border-t-accent",
              dimmed && "opacity-55",
            )}
            data-testid="chain-row"
          >
            <button
              type="button"
              className="mt-0.5 cursor-grab touch-none rounded-md p-1 text-fg-subtle hover:bg-subtle active:cursor-grabbing"
              aria-label={t("chain.drag")}
              onPointerDown={onDown(i)}
              onPointerMove={onPointerMove}
              onPointerUp={onUp}
              onPointerCancel={() => setDrag(null)}
            >
              <GripVertical className="h-4 w-4" />
            </button>
            <span className="mt-1 w-5 shrink-0 text-center text-[12px] font-semibold tabular-nums text-fg-subtle">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <p className="break-words text-[14.5px] font-medium leading-5">
                <bdi>{e?.label ?? (modelLabel(ref.model) || ref.model)}</bdi>
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge>{e?.provider_label ?? providerLabel(t, ref.provider)}</Badge>
                {i === 0 && <Badge tone="accent">{t("chain.primary")}</Badge>}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-fg-muted">
                <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", STATE_DOT[state])} aria-hidden />
                <span>{e ? stateText(t, e) : t("chain.state.available")}</span>
              </p>
              <p className="mt-0.5 text-[12px] text-fg-subtle" data-testid="chain-quota">
                {e ? quotaLine(t, e.quota) : t("chain.quota.unknown")}
              </p>
            </div>
            <div className="flex shrink-0 items-center">
              <button type="button" className="rounded-md p-1.5 text-fg-muted hover:bg-subtle disabled:opacity-30" aria-label={t("chain.moveUp")} disabled={i === 0} onClick={() => onMove(i, i - 1)}>
                <ChevronUp className="h-4 w-4" />
              </button>
              <button type="button" className="rounded-md p-1.5 text-fg-muted hover:bg-subtle disabled:opacity-30" aria-label={t("chain.moveDown")} disabled={i === list.length - 1} onClick={() => onMove(i, i + 1)}>
                <ChevronDown className="h-4 w-4" />
              </button>
              <button type="button" className="rounded-md p-1.5 text-fg-muted hover:bg-danger-soft hover:text-danger" aria-label={t("chain.remove")} onClick={() => onRemove(i)}>
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}


type PickSource = { kind: "provider"; id: AiProviderId } | { kind: "endpoint"; id: string };

function AddModelDialog({ open, onClose, catalog, endpoints, list, onAdd }: { open: boolean; onClose: () => void; catalog: CatalogResponse; endpoints: EndpointInfo[]; list: ChainRef[]; onAdd: (r: ChainRef) => void }) {
  const t = useT();
  const sources: { value: string; label: string; source: PickSource }[] = [
    ...catalog.providers.map((p) => ({ value: `p:${p.id}`, label: providerLabel(t, p.id), source: { kind: "provider", id: p.id } as PickSource })),
    ...endpoints.map((e) => ({ value: `e:${e.id}`, label: `${e.name} (${t("chain.endpoint")})`, source: { kind: "endpoint", id: e.id } as PickSource })),
  ];
  const [value, setValue] = useState(sources[0]?.value ?? "");
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const chosen = sources.find((s) => s.value === value)?.source ?? null;
  const endpointModels = useQuery({
    queryKey: ["ai", "endpoint-models", chosen?.kind === "endpoint" ? chosen.id : ""],
    queryFn: () => api<{ models: string[]; error: string | null }>(`/ai/endpoints/${chosen?.id}/models`),
    enabled: open && chosen?.kind === "endpoint",
    staleTime: 5 * 60_000,
  });
  const provider = chosen?.kind === "provider" ? catalog.providers.find((p) => p.id === chosen.id) : undefined;
  const models: { id: string; name: string; ref: ChainRef }[] =
    chosen?.kind === "provider"
      ? (provider?.models ?? []).map((m) => ({ id: m.id, name: m.name, ref: { provider: chosen.id, model: m.id } }))
      : chosen?.kind === "endpoint"
        ? (endpointModels.data?.models ?? []).map((m) => ({ id: m, name: modelLabel(m) || m, ref: { provider: "openai-compatible" as const, model: `${chosen.id}/${m}` } }))
        : [];
  const q = query.trim().toLowerCase();
  const shown = q ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : models;
  const inChain = new Set(list.map(refKey));

  const addManual = (e: FormEvent) => {
    e.preventDefault();
    const id = manual.trim();
    if (!id || !chosen) return;
    onAdd(chosen.kind === "provider" ? { provider: chosen.id, model: id } : { provider: "openai-compatible", model: `${chosen.id}/${id}` });
    setManual("");
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("chain.pick.title")} wide>
      <div className="space-y-3">
        <label className="block text-[13px] font-medium">
          {t("chain.pick.provider")}
          <Select className="mt-1" value={value} onChange={(e) => setValue(e.target.value)} aria-label={t("chain.pick.provider")}>
            {sources.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </Select>
        </label>
        {provider && !provider.connected && provider.needsKey && <p className="text-[12.5px] text-warning">{t("chain.pick.noKey")}</p>}
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("chain.pick.search")} aria-label={t("chain.pick.search")} dir="ltr" />
        <div className="max-h-[42vh] overflow-y-auto rounded-xl border border-border">
          {chosen?.kind === "endpoint" && endpointModels.isLoading ? (
            <p className="flex items-center gap-2 p-3 text-sm text-fg-muted">
              <Spinner /> {t("chain.pick.loading")}
            </p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-fg-muted">{endpointModels.data?.error ?? t("chain.pick.noModels")}</p>
          ) : (
            <ul className="divide-y divide-border/60">
              {shown.map((m) => {
                const already = inChain.has(refKey(m.ref));
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      disabled={already}
                      className="pressable flex w-full items-center gap-2 px-3 py-2.5 text-start hover:bg-subtle disabled:opacity-50"
                      onClick={() => {
                        onAdd(m.ref);
                        onClose();
                      }}
                    >
                      <span className="min-w-0 flex-1">
                        <span dir="ltr" className="block truncate text-sm font-medium">
                          {m.name}
                        </span>
                        <span dir="ltr" className="block truncate text-[11.5px] text-fg-subtle">
                          {m.id}
                        </span>
                      </span>
                      {already ? <Badge>{t("chain.pick.inChain")}</Badge> : <Plus className="h-4 w-4 text-accent" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <form className="flex gap-2" onSubmit={addManual}>
          <Input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t("chain.pick.manual")} aria-label={t("chain.pick.manual")} dir="ltr" />
          <Button type="submit" variant="outline" disabled={!manual.trim()}>
            {t("chain.pick.add")}
          </Button>
        </form>
      </div>
    </Dialog>
  );
}

function AddEndpointDialog({ open, onClose, taken, onAdded }: { open: boolean; onClose: () => void; taken: string[]; onAdded: (ref: ChainRef, name: string) => void }) {
  const t = useT();
  const toast = useToast();
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const https = baseURL.trim() === "" || baseURL.trim().startsWith("https://");
  const ready = name.trim() && baseURL.trim().startsWith("https://") && model.trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    try {
      const id = endpointIdFromName(name.trim(), taken);
      await api(`/ai/endpoints/${id}`, { method: "PUT", body: { name: name.trim(), baseURL: baseURL.trim(), ...(key.trim() ? { key: key.trim() } : {}) } });
      onAdded({ provider: "openai-compatible", model: `${id}/${model.trim()}` }, name.trim());
      setName("");
      setBaseURL("");
      setKey("");
      setModel("");
      onClose();
    } catch (err) {
      toast(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("chain.ep.title")}>
      <form className="space-y-3" onSubmit={(e) => void submit(e)}>
        <p className="text-[12.5px] leading-5 text-fg-muted">{t("chain.ep.hint")}</p>
        <label className="block text-[13px] font-medium">
          {t("chain.ep.name")}
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Z.ai" maxLength={60} dir="auto" required />
        </label>
        <label className="block text-[13px] font-medium">
          {t("chain.ep.baseURL")}
          <Input className="mt-1" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://api.example.com/v1" dir="ltr" inputMode="url" required />
          {!https && <span className="mt-1 block text-[12px] text-danger">{t("chain.ep.httpsOnly")}</span>}
        </label>
        <label className="block text-[13px] font-medium">
          {t("chain.ep.key")}
          <Input className="mt-1" value={key} onChange={(e) => setKey(e.target.value)} type="password" autoComplete="off" dir="ltr" />
        </label>
        <label className="block text-[13px] font-medium">
          {t("chain.ep.model")}
          <Input className="mt-1" value={model} onChange={(e) => setModel(e.target.value)} placeholder="glm-4.7-flash" dir="ltr" required />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={busy} disabled={!ready}>
            {t("chain.ep.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
