import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiProviderId, CatalogModel, CatalogProvider, FallbackSettings, ModelCatalog, Settings } from "@talorys/shared";
import { Check, ExternalLink, KeyRound, RefreshCw, Trash2 } from "lucide-react";
import { type ComponentType, type FormEvent, type ReactNode, useState } from "react";
import { useToast, errorMessage } from "../hooks/toast";
import { keys as queryKeys, useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";
import { type StringKey, useLocale, useT } from "../lib/i18n";
import { cn, relativeTime } from "../lib/utils";
import { Badge, Button, Input, Select, Spinner, Switch } from "./ui";
import { providerLabel } from "../lib/provider-label";

type SectionProps = { title?: string; children: ReactNode; inset?: boolean };
type RowProps = { label: string; hint?: ReactNode; children: ReactNode };

interface CatalogResponse extends ModelCatalog {
  keys_available: boolean;
  fallback: FallbackSettings;
}

export const MODEL_CATALOG_KEY = ["ai", "models"] as const;

export function useModelCatalog() {
  return useQuery({ queryKey: MODEL_CATALOG_KEY, queryFn: () => api<CatalogResponse>("/ai/models"), staleTime: 5 * 60 * 1000 });
}

/** The short label of a model id, for rows and the Settings home. */
export function shortModel(id: string): string {
  const last = id.split("/").at(-1) ?? id;
  return last.replace(/-it$/, "").replace(/-a4b$/, "").replace(/:free$/, "");
}

// Lives in lib/provider-label so the chat screen can name a provider without pulling this page into startup JS.
export { providerLabel };

/**
 * Settings → Model: every provider with its models, the current one marked; API-key cards for the
 * providers that need one (the key goes straight to the agent, which checks it with the provider
 * and stores it encrypted; the page only ever sees its last four characters); and the backup model.
 */
export function ModelPicker({ settings, Section, Row }: { settings: Settings; Section: ComponentType<SectionProps>; Row: ComponentType<RowProps> }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = useModelCatalog();
  const [refreshing, setRefreshing] = useState(false);

  const choose = useApiMutation(
    (m: { provider: AiProviderId; model: string }) => api<{ settings: Settings }>("/settings", { method: "PATCH", body: { modelProvider: m.provider, model: m.model } }),
    {
      success: (r) => t("model.changed", { name: shortModel(r.settings.model) }),
      onSuccess: (r) => {
        qc.setQueryData(queryKeys.settings, r.settings);
        void qc.invalidateQueries({ queryKey: MODEL_CATALOG_KEY });
        void qc.invalidateQueries({ queryKey: queryKeys.usage });
      },
    },
  );

  async function refresh() {
    setRefreshing(true);
    try {
      const fresh = await api<CatalogResponse>("/ai/models?refresh=1");
      qc.setQueryData(MODEL_CATALOG_KEY, fresh);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setRefreshing(false);
    }
  }

  if (catalog.isLoading || !catalog.data) {
    return (
      <Section title={t("model.title")}>
        <div className="flex justify-center p-6">
          <Spinner />
        </div>
      </Section>
    );
  }
  const data = catalog.data;
  const current = { provider: settings.modelProvider, model: settings.model };
  const currentProvider = data.providers.find((p) => p.id === current.provider);
  const currentModel = currentProvider?.models.find((m) => m.id === current.model);

  return (
    <div className="space-y-5" data-testid="model-picker">
      <Section title={t("model.title")}>
        <Row label={t("model.current")} hint={t("model.chooseHint")}>
          <div className="flex items-center justify-end gap-2 text-sm">
            <span dir="ltr" className="truncate font-medium">
              {currentModel?.name ?? shortModel(current.model)}
            </span>
            <Badge tone="accent">{providerLabel(t, current.provider)}</Badge>
          </div>
        </Row>
        <div className="flex justify-end px-4 pb-3">
          <Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={refreshing}>
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} /> {refreshing ? t("model.refreshing") : t("model.refresh")}
          </Button>
        </div>
      </Section>

      {data.providers.map((p) => (
        <ProviderSection key={p.id} provider={p} current={current} keysAvailable={data.keys_available} busy={choose.isPending} onChoose={(model) => choose.mutate({ provider: p.id, model })} Section={Section} />
      ))}

      <FallbackSection settings={settings} catalog={data} Section={Section} Row={Row} />
    </div>
  );
}

function ProviderSection({
  provider: p,
  current,
  keysAvailable,
  busy,
  onChoose,
  Section,
}: {
  provider: CatalogProvider;
  current: { provider: AiProviderId; model: string };
  keysAvailable: boolean;
  busy: boolean;
  onChoose: (model: string) => void;
  Section: ComponentType<SectionProps>;
}) {
  const t = useT();
  const usable = p.connected;
  return (
    <Section title={providerLabel(t, p.id)}>
      <div className="px-4 pt-3.5 pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={p.connected ? "success" : "warning"}>{p.connected ? t("model.connected") : p.needsKey ? t("model.needsKey") : t("model.noBinding")}</Badge>
          {p.source === "static" && p.error && <span className="text-[12px] text-fg-subtle">{t("model.sourceStatic", { error: p.error })}</span>}
        </div>
        <p className="mt-2 text-[12.5px] leading-5 text-fg-muted">{t(`model.provider.${p.id}Hint` as StringKey)}</p>
      </div>
      {p.needsKey && <KeyCard provider={p} keysAvailable={keysAvailable} />}
      {!usable && p.needsKey && <p className="px-4 pb-2 text-[12.5px] text-fg-subtle">{t("model.disabledNoKey")}</p>}
      <div role="radiogroup" aria-label={providerLabel(t, p.id)} className="divide-y divide-border/60">
        {p.models.length === 0 && <p className="px-4 py-3 text-sm text-fg-muted">{t("model.listEmpty")}</p>}
        {p.models.map((m) => (
          <ModelRow key={m.id} model={m} selected={current.provider === p.id && current.model === m.id} disabled={!usable || busy} onChoose={() => onChoose(m.id)} />
        ))}
      </div>
    </Section>
  );
}

/**
 * Short Hebrew lines for the models people actually pick; the rest show the provider's own
 * (English) description, clamped to two lines. Speed / quality / tools / price are the tags below.
 */
const HE_DESCRIPTIONS: Record<string, string> = {
  "gemini-3.5-flash": "מהיר וחכם, מומלץ לשימוש יומיומי. מתחיל לענות תוך כשנייה.",
  "gemini-3.5-flash-lite": "הכי מהיר וחסכוני, לשאלות קצרות. מתאים כמודל גיבוי.",
  "gemini-3.8-flash": "החדש והחזק של Flash. במסלול החינמי הוא לפעמים עמוס ועלול להתעכב.",
  "gemini-3.7-flash": "דור קודם של Flash. חזק, לפעמים עמוס במסלול החינמי.",
  "gemini-3.6-flash": "דור קודם של Flash, יציב.",
  "gemini-3.1-flash-lite": "קל ומהיר, דור קודם.",
  "gemini-3.1-pro-preview": "החזק ביותר לחשיבה מורכבת. איטי יותר, ומכסה חינמית קטנה.",
  "gemini-3-flash-preview": "גרסת תצוגה מוקדמת של Gemini 3 Flash.",
  "@cf/google/gemma-4-26b-a4b-it": "Gemma 4 של גוגל, רץ ב-Cloudflare. היה המודל הראשי של Talorys.",
  "@cf/zai-org/glm-4.7-flash": "מהיר, תומך בכלים. מודל גיבוי טוב ב-Cloudflare.",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": "Llama גדול ומהיר. צורך הרבה מהמכסה היומית.",
  "@cf/qwen/qwen3-30b-a3b-fp8": "Qwen מהיר, טוב בהפעלת כלים.",
  "@cf/mistralai/mistral-small-3.1-24b-instruct": "Mistral קטן ומאוזן.",
  "@cf/openai/gpt-oss-120b": "מודל פתוח של OpenAI. חזק בחשיבה, איטי יותר.",
  "@cf/openai/gpt-oss-20b": "גרסה קטנה ומהירה של gpt-oss.",
  "google/gemma-4-26b-a4b-it:free": "Gemma 4 בחינם דרך OpenRouter, עם הגבלת קצב.",
  "openrouter/free": "OpenRouter בוחר לבד מודל חינמי פנוי.",
};

function ModelRow({ model: m, selected, disabled, onChoose }: { model: CatalogModel; selected: boolean; disabled: boolean; onChoose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const he = locale === "he" ? HE_DESCRIPTIONS[m.id] : undefined;
  const description = he ?? m.description;
  const tags: { text: string; tone: "neutral" | "accent" | "success" | "warning" }[] = [];
  if (m.speed) tags.push({ text: t(`model.tag.speed.${m.speed}` as StringKey), tone: "neutral" });
  if (m.quality) tags.push({ text: t(`model.tag.quality.${m.quality}` as StringKey), tone: "neutral" });
  tags.push(m.tools ? { text: t("model.tag.tools"), tone: "success" } : { text: t("model.tag.noTools"), tone: "warning" });
  tags.push(m.free ? { text: t("model.tag.free"), tone: "success" } : { text: t("model.tag.paid"), tone: "warning" });
  if (m.context) tags.push({ text: t("model.tag.context", { n: Math.round(m.context / 1000) }), tone: "neutral" });
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled && !selected}
      onClick={onChoose}
      data-model={m.id}
      className={cn("pressable flex w-full items-start gap-3 px-4 py-3 text-start transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50", selected && "bg-accent-soft/40")}
    >
      <span className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border", selected ? "border-accent bg-accent text-accent-fg" : "border-border-strong")} aria-hidden>
        {selected && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span dir="ltr" className="text-[15px] font-medium">
            {m.name}
          </span>
          {m.recommended && <Badge tone="accent">{t("model.recommended")}</Badge>}
          {selected && <span className="text-[12px] text-accent">{t("model.selected")}</span>}
        </span>
        {description && (
          <span dir="auto" className={cn("mt-0.5 block text-[12.5px] leading-5 text-fg-muted", !he && "line-clamp-2")}>
            {description}
          </span>
        )}
        <span className="mt-1.5 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <Badge key={tag.text} tone={tag.tone} className="text-[11px]">
              {tag.text}
            </Badge>
          ))}
          {m.price && (
            <span dir="ltr" className="self-center text-[11px] text-fg-subtle">
              {t("model.tag.price", { in: m.price.input, out: m.price.output })}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

/** The masked key field. The value is posted once and never read back. */
function KeyCard({ provider: p, keysAvailable }: { provider: CatalogProvider; keysAvailable: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: MODEL_CATALOG_KEY });
    void qc.invalidateQueries({ queryKey: queryKeys.settings });
  };
  const save = useApiMutation((key: string) => api<{ key: { hint: string } }>(`/ai/keys/${p.id}`, { method: "PUT", body: { key } }), {
    success: () => t("model.key.saved", { provider: providerLabel(t, p.id) }),
    onSuccess: () => {
      setValue("");
      setError(null);
      invalidate();
    },
  });
  const test = useApiMutation(() => api<{ ok: boolean }>(`/ai/keys/${p.id}/test`, { method: "POST" }), { success: () => t("model.key.testOk", { provider: providerLabel(t, p.id) }) });
  const remove = useApiMutation(() => api(`/ai/keys/${p.id}`, { method: "DELETE" }), { success: () => t("model.key.removed"), onSuccess: invalidate });

  function submit(e: FormEvent) {
    e.preventDefault();
    const key = value.trim();
    if (key.length < 8) return;
    setError(null);
    save.mutate(key, { onError: (err) => setError(errorMessage(err)) });
  }

  const how = p.id === "gemini" ? t("model.key.howGemini") : t("model.key.howOpenrouter");
  return (
    <div className="mx-3.5 mb-3 rounded-xl border border-border bg-surface p-3.5" data-testid={`key-card-${p.id}`}>
      <div className="flex items-center gap-2 text-[14px] font-medium">
        <KeyRound className="h-4 w-4 text-fg-muted" /> {t("model.key.title")}
      </div>
      {p.connected ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-[13px] text-fg-muted">
            {t("model.key.stored", { hint: p.keyHint ?? "", when: relativeTime(p.keyAddedAt) })}
            <span className="block text-[12px] text-fg-subtle">{t("model.key.neverShown")}</span>
          </p>
          <Button variant="outline" size="sm" loading={test.isPending} onClick={() => test.mutate(undefined)}>
            {t("model.key.test")}
          </Button>
          <Button variant="ghost" size="sm" loading={remove.isPending} onClick={() => remove.mutate(undefined)} aria-label={t("model.key.remove")}>
            <Trash2 className="h-4 w-4" /> {t("model.key.remove")}
          </Button>
        </div>
      ) : !keysAvailable ? (
        <p className="mt-2 text-[13px] text-danger">{t("model.key.unavailable")}</p>
      ) : (
        <form onSubmit={submit} className="mt-2 space-y-2">
          <p className="text-[12.5px] leading-5 text-fg-muted" dir="auto">
            {how}
          </p>
          <div className="flex gap-2">
            <Input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={t("model.key.placeholder")}
              autoComplete="off"
              spellCheck={false}
              dir="ltr"
              aria-label={`${providerLabel(t, p.id)} ${t("model.key.title")}`}
              className="font-mono text-sm"
            />
            <Button type="submit" variant="primary" size="md" loading={save.isPending} disabled={value.trim().length < 8}>
              {save.isPending ? t("model.key.saving") : t("model.key.save")}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-danger" dir="auto">
              {error}
            </p>
          )}
          {p.keyUrl && (
            <a href={p.keyUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] text-accent hover:underline">
              {t("model.key.get")} <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </form>
      )}
    </div>
  );
}

function FallbackSection({ settings, catalog, Section, Row }: { settings: Settings; catalog: CatalogResponse; Section: ComponentType<SectionProps>; Row: ComponentType<RowProps> }) {
  const t = useT();
  const qc = useQueryClient();
  const save = useApiMutation((fallback: Partial<FallbackSettings>) => api<{ settings: Settings }>("/settings", { method: "PATCH", body: { fallback } }), {
    success: t("settings.saved"),
    onSuccess: (r) => qc.setQueryData(queryKeys.settings, r.settings),
  });
  // Every usable model that is not the chosen one.
  const options = catalog.providers
    .filter((p) => p.connected)
    .flatMap((p) => p.models.filter((m) => !(p.id === settings.modelProvider && m.id === settings.model)).map((m) => ({ provider: p.id, model: m.id, label: `${m.name} · ${providerLabel(t, p.id)}` })));
  const fb = settings.fallback;
  const value = `${fb.provider}|${fb.model}`;
  const listed = options.some((o) => `${o.provider}|${o.model}` === value);
  return (
    <Section title={t("model.fallback.title")}>
      <Row label={t("model.fallback.enable")} hint={t("model.fallback.hint")}>
        <div className="flex justify-end">
          <Switch
            checked={fb.enabled}
            disabled={options.length === 0 && !fb.enabled}
            label={t("model.fallback.enable")}
            onChange={(enabled) => {
              const first = options[0];
              save.mutate(enabled && !listed && first ? { enabled, provider: first.provider, model: first.model } : { enabled });
            }}
          />
        </div>
      </Row>
      {fb.enabled && (
        <Row label={t("model.fallback.model")} hint={options.length === 0 ? t("model.fallback.none") : undefined}>
          <Select
            value={listed ? value : ""}
            aria-label={t("model.fallback.model")}
            onChange={(e) => {
              const [provider, model] = e.target.value.split("|") as [AiProviderId, string];
              if (provider && model) save.mutate({ provider, model });
            }}
          >
            {!listed && <option value="">{fb.model}</option>}
            {options.map((o) => (
              <option key={`${o.provider}|${o.model}`} value={`${o.provider}|${o.model}`}>
                {o.label}
              </option>
            ))}
          </Select>
        </Row>
      )}
    </Section>
  );
}
