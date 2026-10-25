import { type ReactNode, useEffect, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { useNav } from "../lib/native";
import { BellButton, MenuButton, TopBar } from "../components/AppShell";
import { DeviceNotificationsSection } from "../components/DeviceNotifications";
import { ModelPicker, providerLabel, shortModel } from "../components/ModelPicker";
import { ConnectionsSection } from "../components/ConnectionsSection";
import { useQueryClient } from "@tanstack/react-query";
import type { Limits, MemoryHistorySettings, Settings } from "@talorys/shared";
import { LIMIT_CEILINGS, TALORYS_VERSION } from "@talorys/shared/constants";
import { checkPasswordStrength } from "@talorys/shared/password-policy";
import { ChevronLeft, ChevronRight, Cpu, Download, ExternalLink, Info, Languages, Lightbulb, Lock, LogOut, Moon, Settings2, ShieldCheck, Smartphone, Sun, Upload } from "lucide-react";
import { GitHubIcon } from "../components/SourceLinks";
import { ANDROID_SOURCE_URL, DEPLOY_DOC_URL, REPO_URL, UPSTREAM_URL } from "../lib/links";
import { Badge, Button, ConfirmDialog, ErrorNotice, Input, Label, Select, Spinner, Switch } from "../components/ui";
import { SemanticRecallCard } from "../components/SemanticRecallCard";
import { keys, useApiMutation, useSessions, useSettings, useSystemInfo, useUsage } from "../hooks/queries";
import type { ProactiveSettings } from "@talorys/shared";
import { useSession } from "../hooks/session";
import { useToast, errorMessage } from "../hooks/toast";
import { api, ApiError } from "../lib/api";
import { applyTheme, readThemePreference, type ThemePreference } from "../lib/theme";
import { cn, relativeTime } from "../lib/utils";
import { LOCALE_NAMES, LOCALES, type LocalePreference, type StringKey, useLocale } from "../lib/i18n";

const TABS = ["General", "AI", "Privacy", "Security", "Proactive", "About"] as const;
type Tab = (typeof TABS)[number];

/** A settings row: label + hint on the start side, the control on the end side (stacked on phones). */
function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="text-[15px]">{label}</p>
        {hint && <p className="mt-0.5 text-[12.5px] leading-5 text-fg-muted">{hint}</p>}
      </div>
      <div className="shrink-0 sm:w-64">{children}</div>
    </div>
  );
}

/** A grouped box, the way native settings screens group rows. */
function Section({ title, children, inset }: { title?: string; children: ReactNode; inset?: boolean }) {
  return (
    <section>
      {title && <h2 className="px-2 pb-1.5 text-[12.5px] font-semibold text-fg-muted">{title}</h2>}
      <div className={cn("settings-group overflow-hidden rounded-xl bg-subtle", inset && "settings-group-inset")}>{children}</div>
    </section>
  );
}

/** A tappable row that opens a sub-screen. */
function LinkRow({ icon: Icon, label, value, onClick }: { icon: typeof Lock; label: string; value?: ReactNode; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="pressable flex min-h-[50px] w-full items-center gap-3 px-3.5 text-start text-[15px] hover:bg-muted/60">
      <span className="grid w-[22px] place-items-center text-fg-muted" aria-hidden>
        <Icon className="h-[19px] w-[19px]" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex items-center gap-1 text-sm text-fg-muted">
        {value}
        <ChevronRight className="h-4 w-4 text-fg-subtle rtl:hidden" aria-hidden />
        <ChevronLeft className="hidden h-4 w-4 text-fg-subtle rtl:block" aria-hidden />
      </span>
    </button>
  );
}

const TAB_LABELS: Record<Tab, Parameters<ReturnType<typeof useLocale>["t"]>[0]> = {
  General: "settings.tab.General",
  AI: "settings.tab.AI",
  Privacy: "settings.tab.Privacy",
  Security: "settings.tab.Security",
  Proactive: "settings.tab.Proactive",
  About: "settings.tab.About",
};

export default function SettingsPage() {
  const [searchParams] = useSearchParams();
  const nav = useNav();
  const location = useLocation();
  const param = searchParams.get("tab");
  const tab: Tab | null = TABS.find((t) => t === param) ?? null;
  // A sub-screen is pushed (slide in) so the Android back button returns to the Settings list; the
  // list's own back button pops that entry when it is ours, else it just shows the list.
  const setTab = (next: Tab | null) => {
    if (next) nav(`/settings?tab=${next}`, "push", { state: { settingsPushed: true } });
    else if ((location.state as { settingsPushed?: boolean } | null)?.settingsPushed) nav(-1, "pop");
    else nav("/settings", "pop", { replace: true });
  };
  const { data: settings, isLoading, error, refetch } = useSettings();
  const { t } = useLocale();
  const info = useSystemInfo();

  const body = error ? (
    <ErrorNotice error={error} onRetry={() => void refetch()} />
  ) : isLoading || !settings ? (
    <div className="flex justify-center py-16">
      <Spinner />
    </div>
  ) : tab === null ? (
    <div className="space-y-5 animate-fade-in">
      <AppearanceSection />
      <DeviceNotificationsSection Section={Section} Row={Row} />
      <Section title={t("settings.connections")} inset>
        <LinkRow icon={Cpu} label={t("settings.model")} value={<span dir="ltr">{shortModel(settings.model)} · {providerLabel(t, settings.modelProvider)}</span>} onClick={() => setTab("AI")} />
        <ConnectionsSection />
      </Section>
      <Section title={t("settings.account")} inset>
        <LinkRow icon={Settings2} label={t("settings.tab.General")} value={settings.agentName} onClick={() => setTab("General")} />
        <LinkRow icon={Lightbulb} label={t("settings.tab.Proactive")} value={settings.proactive.enabled ? <span className="text-accent text-sm">{t("common.on")}</span> : undefined} onClick={() => setTab("Proactive")} />
        <LinkRow icon={ShieldCheck} label={t("settings.tab.Privacy")} onClick={() => setTab("Privacy")} />
        <LinkRow icon={Lock} label={t("settings.tab.Security")} onClick={() => setTab("Security")} />
        <LinkRow icon={Info} label={t("settings.tab.About")} value={<span dir="ltr">{info.data?.deployed_version ?? TALORYS_VERSION}</span>} onClick={() => setTab("About")} />
      </Section>
    </div>
  ) : (
    <div className="space-y-5 animate-fade-in">
      {tab === "General" && <GeneralTab settings={settings} />}
      {tab === "AI" && <AiTab settings={settings} />}
      {tab === "Privacy" && <PrivacyTab />}
      {tab === "Security" && <SecurityTab />}
      {tab === "Proactive" && <ProactiveTab settings={settings} />}
      {tab === "About" && <AboutTab />}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {tab === null ? (
        <TopBar start={<MenuButton />} end={<BellButton />} />
      ) : (
        <TopBar
          start={
            <button type="button" onClick={() => setTab(null)} className="pressable flex h-10 items-center gap-0.5 rounded-xl pe-2 ps-1 text-[15px] text-accent-text hover:bg-subtle" aria-label={t("settings.back")}>
              <ChevronLeft className="h-5 w-5 rtl:hidden" />
              <ChevronRight className="hidden h-5 w-5 rtl:block" />
              {t("settings.title")}
            </button>
          }
          title={<h1 className="text-[16px] font-semibold">{t(TAB_LABELS[tab])}</h1>}
        />
      )}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pb-[max(2.5rem,env(safe-area-inset-bottom))] pt-1 md:px-6">
          {tab === null && <h1 className="px-1 pb-4 pt-1 text-[28px] font-semibold tracking-[-0.01em]">{t("settings.title")}</h1>}
          {tab !== null && <div className="h-2" />}
          {body}
        </div>
      </div>
    </div>
  );
}

const THEMES: { value: ThemePreference; icon: typeof Sun; label: "settings.theme.light" | "settings.theme.dark" | "settings.theme.auto" }[] = [
  { value: "light", icon: Sun, label: "settings.theme.light" },
  { value: "dark", icon: Moon, label: "settings.theme.dark" },
  { value: "system", icon: Smartphone, label: "settings.theme.auto" },
];

function AppearanceSection() {
  const { t, preference, detected, setPreference } = useLocale();
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  return (
    <Section title={t("settings.appearance")}>
      <div className="px-3.5 py-3">
        <div className="flex gap-[3px] rounded-[11px] bg-muted p-[3px]" role="radiogroup" aria-label={t("settings.theme")}>
          {THEMES.map(({ value, icon: Icon, label }) => (
            <button
              type="button"
              key={value}
              role="radio"
              aria-checked={theme === value}
              onClick={() => {
                applyTheme(value);
                setTheme(value);
              }}
              className={cn(
                "pressable flex h-[34px] flex-1 items-center justify-center gap-1.5 rounded-[9px] text-[13.5px] font-medium transition-colors",
                theme === value ? "bg-[var(--seg-on)] text-fg shadow-sm" : "text-fg-muted",
              )}
            >
              <Icon className="h-4 w-4" />
              {t(label)}
            </button>
          ))}
        </div>
      </div>
      <div className="flex min-h-[50px] items-center gap-3 px-3.5">
        <span className="grid w-[22px] place-items-center text-fg-muted" aria-hidden>
          <Languages className="h-[19px] w-[19px]" />
        </span>
        <label htmlFor="settings-language" className="min-w-0 flex-1 text-[15px]">
          {t("settings.language")}
        </label>
        <Select
          id="settings-language"
          value={preference}
          onChange={(e) => setPreference(e.target.value as LocalePreference)}
          aria-label={t("settings.language")}
          className="h-9 w-auto border-0 bg-transparent py-0 pe-7 text-end text-sm text-fg-muted focus:ring-0"
        >
          <option value="auto">{t("settings.language.auto", { name: LOCALE_NAMES[detected] })}</option>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_NAMES[l]}
            </option>
          ))}
        </Select>
      </div>
    </Section>
  );
}

function useSaveSettings() {
  const qc = useQueryClient();
  const { t } = useLocale();
  type Patch = Partial<Omit<Settings, "limits" | "memoryHistory" | "proactive">> & { limits?: Partial<Limits>; memoryHistory?: Partial<MemoryHistorySettings>; proactive?: Partial<ProactiveSettings> };
  return useApiMutation((patch: Patch) => api<{ settings: Settings }>("/settings", { method: "PATCH", body: patch }), {
    success: t("settings.saved"),
    onSuccess: (r) => {
      qc.setQueryData(keys.settings, r.settings);
      void qc.invalidateQueries({ queryKey: ["session"] });
      void qc.invalidateQueries({ queryKey: keys.automations });
    },
  });
}

function GeneralTab({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const { t } = useLocale();
  const [name, setName] = useState(settings.agentName);
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [settings.timezone];
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <Section title={t("settings.general")}>
      <Row label={t("settings.agentName")} hint={t("settings.agentNameHint")}>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name !== settings.agentName) save.mutate({ agentName: name.trim() });
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} aria-label={t("settings.agentName")} dir="auto" />
          <Button type="submit" variant="outline" disabled={!name.trim() || name === settings.agentName}>
            {t("common.save")}
          </Button>
        </form>
      </Row>
      <Row
        label={t("settings.timezone")}
        hint={
          settings.timezone !== browserTz ? (
            <button type="button" className="text-accent underline-offset-2 hover:underline" onClick={() => save.mutate({ timezone: browserTz })}>
              {t("settings.useDeviceTimezone", { tz: browserTz })}
            </button>
          ) : (
            t("settings.timezoneHint")
          )
        }
      >
        <Select value={settings.timezone} onChange={(e) => save.mutate({ timezone: e.target.value })} aria-label={t("settings.timezone")}>
          {(zones.includes(settings.timezone) ? zones : [settings.timezone, ...zones]).map((z) => (
            <option key={z} value={z}>
              {z}
            </option>
          ))}
        </Select>
      </Row>
    </Section>
  );
}

const LIMIT_FIELDS: (keyof Limits)[] = ["maxOutputTokens", "maxContextTokens", "maxToolCalls", "maxAgentIterations", "maxAiRequestsPerDay", "maxScheduledAiRunsPerDay"];

function AiTab({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const usage = useUsage();
  const { t } = useLocale();
  const [limits, setLimits] = useState<Limits>(settings.limits);
  const [temperature, setTemperature] = useState(settings.temperature);
  const dirtyLimits = JSON.stringify(limits) !== JSON.stringify(settings.limits) || temperature !== settings.temperature;
  return (
    <>
      <ModelPicker settings={settings} Section={Section} Row={Row} />

      <Section title={t("settings.tab.AI")}>
        <Row label={t("ai.learn")} hint={t("ai.learnHint")}>
          <div className="flex justify-end">
            <Switch checked={settings.autoMemory} onChange={(v) => save.mutate({ autoMemory: v })} label={t("ai.learn")} />
          </div>
        </Row>
        <Row label={t("ai.demo")} hint={t("ai.demoHint")}>
          <div className="flex justify-end">
            <Switch checked={settings.demoMode} onChange={(v) => save.mutate({ demoMode: v })} label={t("ai.demo")} />
          </div>
        </Row>
      </Section>

      <Section title={t("ai.limits")}>
        <Row label={t("ai.temperature")} hint={t("ai.temperatureHint")}>
          <div className="flex items-center gap-3">
            <input type="range" min={0} max={1.5} step={0.1} value={temperature} onChange={(e) => setTemperature(Number(e.target.value))} className="flex-1 accent-[var(--accent)]" aria-label={t("ai.temperature")} />
            <span className="w-8 text-end text-sm tabular-nums">{temperature.toFixed(1)}</span>
          </div>
        </Row>
        {LIMIT_FIELDS.map((key) => (
          <Row key={key} label={t(`ai.limit.${key}` as StringKey)} hint={`${t(`ai.limit.${key}Hint` as StringKey)} ${t("ai.limit.max", { n: LIMIT_CEILINGS[key] })}`}>
            <Input
              type="number"
              min={0}
              max={LIMIT_CEILINGS[key]}
              value={limits[key]}
              onChange={(e) => setLimits({ ...limits, [key]: Number(e.target.value) })}
              aria-label={t(`ai.limit.${key}` as StringKey)}
            />
          </Row>
        ))}
        <div className="flex justify-end gap-2 px-4 py-3">
          <Button
            variant="ghost"
            disabled={!dirtyLimits}
            onClick={() => {
              setLimits(settings.limits);
              setTemperature(settings.temperature);
            }}
          >
            {t("ai.reset")}
          </Button>
          <Button disabled={!dirtyLimits} loading={save.isPending} onClick={() => save.mutate({ limits, temperature })}>
            {t("ai.saveLimits")}
          </Button>
        </div>
      </Section>

      <Section title={t("ai.usage")}>
        {usage.isLoading || !usage.data ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
              {[
                [t("ai.usage.requests"), `${usage.data.today.ai_requests} / ${usage.data.limits.maxAiRequestsPerDay}`],
                [t("ai.usage.tokens"), (usage.data.today.input_tokens_estimate + usage.data.today.output_tokens_estimate).toLocaleString()],
                [t("ai.usage.toolCalls"), String(usage.data.today.tool_calls)],
                [t("ai.usage.scheduled"), `${usage.data.today.scheduled_ai_runs} / ${usage.data.limits.maxScheduledAiRunsPerDay}`],
              ].map(([label, value]) => (
                <div key={label} className="bg-surface px-5 py-4">
                  <p className="text-xs text-fg-subtle">{label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            <Row label={t("ai.usage.last7")} hint={t("ai.usage.last7Hint")}>
              <p className="text-end text-sm tabular-nums text-fg-muted">{t("ai.usage.last7Value", { requests: usage.data.last_7_days.ai_requests, errors: usage.data.last_7_days.ai_errors })}</p>
            </Row>
            <div className="px-5 py-4 text-xs leading-5 text-fg-subtle">
              <Badge tone="warning" className="mb-2">
                {t("ai.usage.estimates")}
              </Badge>
              <p>{t("ai.usage.note")}</p>
              <a href={usage.data.dashboard_url} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-accent hover:underline">
                {t("ai.usage.dashboard")} <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </>
        )}
      </Section>
      <SemanticRecallCard />
      <MemoryHistorySection settings={settings} />
    </>
  );
}

function MemoryHistorySection({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const { t } = useLocale();
  const mh = settings.memoryHistory;
  return (
    <Section title={t("ai.memoryHistory")}>
      <Row label={t("ai.conflictReview")} hint={t("ai.conflictReviewHint")}>
        <div className="flex justify-end">
          <Switch checked={mh.conflictReview} onChange={(v) => save.mutate({ memoryHistory: { conflictReview: v } })} label={t("ai.conflictReview")} />
        </div>
      </Row>
      {mh.conflictReview && (
        <Row label={t("ai.aiConflictCheck")} hint={t("ai.aiConflictCheckHint")}>
          <div className="flex justify-end">
            <Switch checked={mh.aiConflictCheck} onChange={(v) => save.mutate({ memoryHistory: { aiConflictCheck: v } })} label={t("ai.aiConflictCheck")} />
          </div>
        </Row>
      )}
    </Section>
  );
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) => ({
  value: h,
  label: `${h.toString().padStart(2, "0")}:00`,
}));

function ProactiveTab({ settings }: { settings: Settings }) {
  const save = useSaveSettings();
  const { t } = useLocale();
  const p = settings.proactive;

  const saveP = (patch: Partial<ProactiveSettings>) =>
    save.mutate({ proactive: patch });

  return (
    <>
      <Section title={t("proactive.title")}>
        <div className="px-4 py-3 text-[13px] leading-5 text-fg-muted">{t("proactive.description")}</div>
        <Row label={t("proactive.enable")} hint={t("proactive.enableHint")}>
          <div className="flex justify-end">
            <Switch checked={p.enabled} onChange={(v) => saveP({ enabled: v })} label={t("proactive.enable")} />
          </div>
        </Row>
        {p.enabled && (
          <>
            <Row label={t("proactive.scanFreq")} hint={t("proactive.scanFreqHint")}>
              <Select
                value={p.scanEveryHours}
                onChange={(e) => saveP({ scanEveryHours: Number(e.target.value) })}
                aria-label={t("proactive.scanFreq")}
              >
                <option value={1}>{t("proactive.every_1_hour")}</option>
                {[2, 3, 4, 6, 8, 12, 24].map((n) => (
                  <option key={n} value={n}>{t("proactive.every_n_hours", { n })}</option>
                ))}
              </Select>
            </Row>
            <Row label={t("proactive.maxPerRun")} hint={t("proactive.maxPerRunHint")}>
              <Input
                type="number"
                min={1}
                max={10}
                value={p.maxPerRun}
                onChange={(e) => saveP({ maxPerRun: Number(e.target.value) })}
                aria-label={t("proactive.maxPerRun")}
              />
            </Row>
            <Row label={t("proactive.quietHours")} hint={t("proactive.quietHoursHint")}>
              <div className="flex items-center gap-2">
                <label className="text-sm text-fg-muted shrink-0">{t("proactive.from")}</label>
                <Select
                  value={p.quietStartHour}
                  onChange={(e) => saveP({ quietStartHour: Number(e.target.value) })}
                  aria-label={t("proactive.from")}
                  className="flex-1"
                >
                  {HOUR_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
                <label className="text-sm text-fg-muted shrink-0">{t("proactive.until")}</label>
                <Select
                  value={p.quietEndHour}
                  onChange={(e) => saveP({ quietEndHour: Number(e.target.value) })}
                  aria-label={t("proactive.until")}
                  className="flex-1"
                >
                  {HOUR_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </Select>
              </div>
            </Row>
          </>
        )}
      </Section>
      <div className="px-2 text-[12px] leading-5 text-fg-subtle">{t("proactive.managedNote")}</div>
    </>
  );
}

const IMPORT_COUNT_KEYS: Record<string, StringKey> = {
  conversations: "privacy.count.conversations",
  messages: "privacy.count.messages",
  memories: "privacy.count.memories",
  tasks: "privacy.count.tasks",
  notes: "privacy.count.notes",
  projects: "privacy.count.projects",
  automations: "privacy.count.automations",
};

function PrivacyTab() {
  const { t } = useLocale();
  const toast = useToast();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [confirm, setConfirm] = useState<"history" | "memories" | null>(null);
  const clear = useApiMutation(
    (what: "history" | "memories") => api(what === "history" ? "/conversations" : "/memories", { method: "DELETE", body: { confirm: "DELETE" } }),
    {
      invalidate: [["conversations"], ["memories"]],
      success: (r) => t("privacy.deletedItems", { n: (r as { deleted: number }).deleted }),
      onSuccess: () => setConfirm(null),
    },
  );

  async function onImport(file: File) {
    setImporting(true);
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error(t("privacy.tooLarge"));
      const json = JSON.parse(await file.text());
      const r = await api<{ imported: Record<string, number> & { automations_paused: number; ignored_settings: string[] } }>("/import", {
        method: "POST",
        body: json,
      });
      const { automations_paused, ignored_settings, ...counts } = r.imported;
      const notes = [
        automations_paused ? t("privacy.importedPaused", { n: automations_paused }) : "",
        ignored_settings.length ? t("privacy.keptSettings", { names: ignored_settings.join(", ") }) : "",
      ].filter(Boolean);
      const countText = Object.entries(counts)
        .map(([k, v]) => (IMPORT_COUNT_KEYS[k] ? t(IMPORT_COUNT_KEYS[k], { n: v }) : `${v} ${k}`))
        .join(", ");
      toast(`${t("privacy.imported", { counts: countText })}${notes.length ? `. ${notes.join("; ")}.` : ""}`);
      await qc.invalidateQueries();
    } catch (error) {
      toast(error instanceof SyntaxError ? t("privacy.invalidJson") : errorMessage(error), "error");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <>
      <Section title={t("privacy.yourData")}>
        <div className="px-5 py-4 text-sm leading-6 text-fg-muted">
          {t("privacy.storage")}
        </div>
        <Row label={t("privacy.export")} hint={t("privacy.exportHint")}>
          <a href="/api/export" download="talorys-backup.json" className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-surface px-4 text-sm font-medium hover:bg-subtle">
            <Download className="h-4 w-4" /> {t("privacy.download")}
          </a>
        </Row>
        <Row label={t("privacy.import")} hint={t("privacy.importHint")}>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => e.target.files?.[0] && void onImport(e.target.files[0])} />
          <Button variant="outline" className="w-full justify-center" loading={importing} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" /> {t("privacy.choose")}
          </Button>
        </Row>
      </Section>
      <Section title={t("privacy.danger")}>
        <Row label={t("privacy.deleteHistory")} hint={t("privacy.deleteHistoryHint")}>
          <Button variant="outline" className="w-full justify-center text-danger" onClick={() => setConfirm("history")}>
            {t("privacy.deleteHistoryBtn")}
          </Button>
        </Row>
        <Row label={t("privacy.clearMemories")} hint={t("privacy.clearMemoriesHint")}>
          <Button variant="outline" className="w-full justify-center text-danger" onClick={() => setConfirm("memories")}>
            {t("privacy.clearMemoriesBtn")}
          </Button>
        </Row>
      </Section>
      <ConfirmDialog
        open={!!confirm}
        title={confirm === "history" ? t("privacy.confirmHistory") : t("privacy.confirmMemories")}
        message={t("privacy.cannotUndo")}
        confirmLabel={confirm === "history" ? t("privacy.deleteAll") : t("privacy.clearAll")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && clear.mutate(confirm)}
        loading={clear.isPending}
      />
    </>
  );
}

/** The shared password policy speaks English; this shows its hint in the UI language. */
function passwordHint(message: string, t: (key: StringKey, vars?: Record<string, string | number>) => string): string {
  const min = /^Use at least (\d+) characters\.$/.exec(message);
  if (min) return t("security.pw.min", { n: min[1] ?? "" });
  if (message.startsWith("Use at most")) return t("security.pw.max");
  if (message.startsWith("Avoid repeating")) return t("security.pw.repeat");
  if (message.startsWith("Mix letters")) return t("security.pw.mix");
  if (message.startsWith("Avoid common words")) return t("security.pw.common");
  return message;
}

function SecurityTab() {
  const { t } = useLocale();
  const { logout } = useSession();
  const sessions = useSessions();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmNext, setConfirmNext] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const rawStrength = next ? checkPasswordStrength(next) : null;
  const strength = rawStrength ? passwordHint(rawStrength, t) : null;
  const change = useApiMutation(() => api("/auth/password", { method: "POST", body: { current_password: current, new_password: next } }), {
    invalidate: [keys.sessions],
    success: t("security.changed"),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirmNext("");
    },
  });
  const revoke = useApiMutation((id: string) => api(`/auth/sessions/${id}`, { method: "DELETE" }), { invalidate: [keys.sessions], success: t("security.sessionOut") });
  const revokeOthers = useApiMutation(() => api("/auth/sessions/revoke-others", { method: "POST", body: {} }), {
    invalidate: [keys.sessions],
    success: t("security.othersOut"),
  });
  useEffect(() => setFormError(change.error instanceof ApiError ? change.error.message : null), [change.error]);

  return (
    <>
      <Section title={t("security.changePassword")}>
        <form
          className="space-y-4 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (next !== confirmNext) return setFormError(t("security.mismatch"));
            if (strength) return setFormError(strength);
            setFormError(null);
            change.mutate(undefined);
          }}
        >
          <input type="text" autoComplete="username" value="owner" readOnly hidden />
          <div>
            <Label htmlFor="pw-current">{t("security.current")}</Label>
            <Input id="pw-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="pw-new">{t("security.new")}</Label>
              <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
              {next && <p className={cn("mt-1 text-xs", strength ? "text-warning" : "text-success")}>{strength ?? t("security.strong")}</p>}
            </div>
            <div>
              <Label htmlFor="pw-confirm">{t("security.confirm")}</Label>
              <Input id="pw-confirm" type="password" autoComplete="new-password" value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} />
            </div>
          </div>
          {formError && <p className="text-sm text-danger">{formError}</p>}
          <div className="flex justify-end">
            <Button type="submit" loading={change.isPending} disabled={!current || !next || !confirmNext}>
              {t("security.changeBtn")}
            </Button>
          </div>
        </form>
      </Section>
      <Section title={t("security.sessions")}>
        {sessions.isLoading ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : (
          sessions.data?.map((s) => (
            <div key={s.id} className="flex items-center justify-between gap-3 px-5 py-3">
              <div className="min-w-0">
                <p className="truncate text-sm">
                  {describeAgent(s.user_agent, t)} {s.current && <Badge tone="accent">{t("security.thisDevice")}</Badge>}
                </p>
                <p className="text-xs text-fg-subtle">
                  {t("security.signedIn", { when: relativeTime(s.created_at), active: relativeTime(s.last_seen_at) })}
                </p>
              </div>
              {!s.current && (
                <Button variant="ghost" size="sm" onClick={() => revoke.mutate(s.id)}>
                  {t("security.signOut")}
                </Button>
              )}
            </div>
          ))
        )}
        <div className="flex flex-wrap justify-end gap-2 px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => revokeOthers.mutate(undefined)} loading={revokeOthers.isPending}>
            {t("security.signOutOthers")}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void logout()}>
            <LogOut className="h-3.5 w-3.5" /> {t("security.lockDevice")}
          </Button>
        </div>
      </Section>
      <p className="px-1 text-xs leading-5 text-fg-subtle">
        {t("security.forgotBefore")}{" "}
        <code className="rounded bg-muted px-1" dir="ltr">
          npx create-talorys@latest reset-password
        </code>{" "}
        {t("security.forgotAfter")}
      </p>
    </>
  );
}

function describeAgent(ua: string, t: (key: StringKey, vars?: Record<string, string | number>) => string): string {
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : t("security.browser");
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? t("security.agentOn", { browser, os }) : browser;
}

function AboutTab() {
  const info = useSystemInfo();
  const { t } = useLocale();
  const { data: settings } = useSettings();
  const standalone = typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches;
  return (
    <Section title={t("settings.tab.About")}>
      <Row label={t("settings.version")}>
        <p className="text-end font-mono text-sm" dir="ltr">{info.data?.deployed_version ?? TALORYS_VERSION}</p>
      </Row>
      <Row label={t("settings.app")}>
        <p className="text-end text-sm text-fg-muted">{standalone ? t("settings.installedApp") : t("settings.notInstalled")}</p>
      </Row>
      <Row label={t("settings.model")}>
        <p className="text-end text-sm text-fg-muted" dir="ltr">{settings ? `${shortModel(settings.model)} · ${providerLabel(t, settings.modelProvider)}` : ""}</p>
      </Row>
      <Row label={t("about.deployment")} hint={t("about.deploymentHint")}>
        <div className="space-y-1 text-end text-xs text-fg-muted">
          {info.data ? (
            <>
              <p>{t("about.installation")}<span className="font-mono">{info.data.installation_id ?? "local"}</span></p>
              <p>{t("about.schema", { v: info.data.schema_version, env: info.data.environment })}</p>
              <p>
                {t("about.ai")}
                {info.data.ai_provider === "mock" ? t("about.demo") : info.data.ai_provider === "none" ? t("about.notAvailable") : providerLabel(t, info.data.ai_provider)}
              </p>
            </>
          ) : (
            <Spinner className="ms-auto h-4 w-4" />
          )}
        </div>
      </Row>
      <Row label={t("about.source")} hint={<>{t("about.sourceBefore")} <a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className="hover:underline">rociiu/talorys</a> (MIT).</>}>
        <div className="flex flex-col items-end gap-1 text-sm">
          <a href={REPO_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-accent hover:underline">
            <GitHubIcon className="h-3.5 w-3.5" /> theyishaik-lab/talorys <ExternalLink className="h-3.5 w-3.5" />
          </a>
          <a href={ANDROID_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-accent hover:underline">
            <GitHubIcon className="h-3.5 w-3.5" /> talorys/apps/mobile <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </Row>
      <Row label={t("about.update")} hint={t("about.updateHint")}>
        <a href={DEPLOY_DOC_URL} target="_blank" rel="noopener noreferrer" className="flex items-center justify-end gap-1 text-sm text-accent hover:underline">
          docs/system/DEPLOY.md <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </Row>
    </Section>
  );
}
