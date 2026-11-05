import type { ChainStatus } from "@talorys/shared";
import * as Notifications from "expo-notifications";
import { useFocusEffect } from "expo-router";
import { Download, FlaskConical, Pause, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, RadioRow, Row, ToggleRow } from "../../components/SettingsList";
import { Button, T, useFont } from "../../components/ui";
import { TalorysKeyboard } from "../../../modules/talorys-keyboard";
import { type BridgeState, type LocalModelSettings, type LocalModelStatus, TalorysLocalLlm } from "../../../modules/talorys-local-llm";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { chainSettingsPatch, chainWithDeviceModel, formatBytes, isUsable, progressPercent } from "../../lib/localModels";
import { DEVICE_MODELS } from "../../lib/shared";
import { radii, useTheme } from "../../lib/theme";

type Native = NonNullable<typeof TalorysLocalLlm>;

/**
 * Settings → Local models (docs/local-models.md): download Spark-X2.5 1.7B / Gemma 4 E4B, try them,
 * let the agent's model chain use them through the device bridge ("Use in chain"), and answer
 * offline when the agent is unreachable.
 */
export default function LocalModelsScreen() {
  const { t } = useI18n();
  const native = TalorysLocalLlm;
  if (!native) {
    return (
      <Screen title={t("lm.title")}>
        <T muted>{t("lm.unavailable")}</T>
      </Screen>
    );
  }
  return <LocalModels native={native} />;
}

function LocalModels({ native }: { native: Native }) {
  const { t } = useI18n();
  const [models, setModels] = useState<LocalModelStatus[]>(() => native.getModels());
  const [settings, setSettings] = useState<LocalModelSettings>(() => native.getSettings());
  const [device] = useState(() => native.getDeviceInfo());
  const [bridge, setBridge] = useState<{ state: BridgeState; detail: string | null }>(() => native.getBridgeState());
  const [progress, setProgress] = useState<Record<string, { done: number; total: number; phase: string }>>({});
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setModels(native.getModels());
    setBridge(native.getBridgeState());
  }, [native]);
  useFocusEffect(refresh);

  useEffect(() => {
    const subs = [
      native.addListener("onDownloadProgress", (e) => {
        setProgress((p) => ({ ...p, [e.id]: { done: e.downloadedBytes, total: e.totalBytes, phase: e.phase } }));
        if (e.phase === "error" && e.error) setNote(e.error);
        if (e.phase !== "downloading") refresh();
      }),
      native.addListener("onModelState", (m) => setModels((list) => list.map((x) => (x.id === m.id ? m : x)))),
      native.addListener("onBridgeState", (b) => setBridge(b)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, [native, refresh]);

  const update = (values: Partial<LocalModelSettings>) => setSettings(native.setSettings(values));

  /** "Use in chain": the phone allows it, and the model is appended to the agent's chain (or removed). */
  const setInChain = async (m: LocalModelStatus, on: boolean) => {
    setModels((list) => list.map((x) => (x.id === m.id ? native.setUseInChain(m.id, on) : x)));
    try {
      const status = await api<ChainStatus>("/ai/chain");
      const next = chainWithDeviceModel(status.entries.map((e) => ({ provider: e.provider, model: e.model })), m.id, on);
      if (next) {
        const patch = chainSettingsPatch(next);
        // A model added to the chain is only reached when the chain is on.
        if (on) patch.fallback.enabled = true;
        await api("/settings", { method: "PATCH", body: patch });
      }
      setNote(on ? t("lm.chainAdded", { name: m.name }) : t("lm.chainRemoved", { name: m.name }));
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };

  const setBackground = async (on: boolean) => {
    if (on) {
      await Notifications.requestPermissionsAsync().catch(() => null);
      // The keyboard's companion foreground service is what keeps the app process (and the bridge) alive.
      TalorysKeyboard?.setPreferences({ alwaysOn: true });
    }
    update({ backgroundBridge: on });
  };

  const usable = models.filter(isUsable);
  return (
    <Screen title={t("lm.title")}>
      <T size={13} muted style={{ paddingHorizontal: 4 }}>
        {t("lm.intro")}
      </T>
      <Group title={t("lm.phone")} footer={t("lm.phoneHint")}>
        <Row title={t("lm.ram")} value={formatBytes(device.totalRamBytes)} />
        <Row title={t("lm.storage")} value={formatBytes(device.freeStorageBytes)} />
        <Row title={t("lm.bridge")} subtitle={bridge.detail && bridge.state !== "connected" ? bridge.detail : undefined} value={t(`lm.bridge.${bridge.state}` as Parameters<typeof t>[0])} last />
      </Group>
      {note ? (
        <T size={13} muted style={{ paddingHorizontal: 4 }}>
          {note}
        </T>
      ) : null}
      {models.map((m) => (
        <ModelCard key={m.id} native={native} model={m} progress={progress[m.id]} onInChain={(on) => setInChain(m, on)} onNote={setNote} />
      ))}
      <Group title={t("lm.options")}>
        <ToggleRow title={t("lm.wifiOnly")} subtitle={t("lm.wifiOnlyHint")} value={settings.wifiOnly} onChange={(v) => update({ wifiOnly: v })} />
        <ToggleRow title={t("lm.offline")} subtitle={t("lm.offlineHint")} value={settings.offlineFallback} onChange={(v) => update({ offlineFallback: v })} disabled={usable.length === 0 && !settings.offlineFallback} />
        <ToggleRow title={t("lm.background")} subtitle={t("lm.backgroundHint")} value={settings.backgroundBridge} onChange={setBackground} last />
      </Group>
      {settings.offlineFallback && usable.length > 1 ? (
        <Group title={t("lm.offlineModel")}>
          {usable.map((m, i) => (
            <RadioRow key={m.id} title={m.name} selected={(settings.offlineModel || usable[0]?.id) === m.id} onPress={() => update({ offlineModel: m.id })} last={i === usable.length - 1} />
          ))}
        </Group>
      ) : null}
      <T size={12} muted style={{ paddingHorizontal: 4 }}>
        {t("lm.footer")}
      </T>
    </Screen>
  );
}

function ModelCard({ native, model: m, progress, onInChain, onNote }: { native: Native; model: LocalModelStatus; progress?: { done: number; total: number; phase: string }; onInChain: (on: boolean) => void; onNote: (s: string) => void }) {
  const { t } = useI18n();
  const { c } = useTheme();
  const spec = DEVICE_MODELS.find((d) => d.id === m.id);
  const downloading = m.state === "downloading";
  const done = progress && downloading ? progress.done : m.downloadedBytes;
  const pct = progressPercent(done, m.sizeBytes);
  const partial = m.state === "not_downloaded" && m.downloadedBytes > 0;
  const usable = isUsable(m);

  const stateLine = (() => {
    if (downloading) return progress?.phase === "verifying" ? t("lm.state.verifying") : t("lm.state.downloading", { pct, done: formatBytes(done), total: formatBytes(m.sizeBytes) });
    if (m.state === "ready") return t("lm.state.ready", { backend: (m.backend ?? "cpu").toUpperCase() });
    if (m.state === "loading") return t("lm.state.loading");
    if (m.state === "downloaded") return t("lm.state.downloaded");
    if (m.state === "error") return t("lm.state.error", { error: m.error ?? "" });
    return partial ? t("lm.state.partial", { done: formatBytes(m.downloadedBytes), total: formatBytes(m.sizeBytes) }) : t("lm.state.notDownloaded", { size: formatBytes(m.sizeBytes) });
  })();

  const footer = m.ram === "block" ? t("lm.ramBlock", { gb: spec?.minRamGb ?? 6 }) : m.ram === "warn" ? t("lm.ramWarn") : undefined;

  const remove = () =>
    Alert.alert(t("lm.deleteTitle", { name: m.name }), t("lm.deleteBody", { size: formatBytes(m.sizeBytes) }), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("lm.delete"), style: "destructive", onPress: () => void native.deleteModel(m.id).catch((e) => onNote(String(e?.message ?? e))) },
    ]);

  return (
    <Group title={m.name} footer={footer}>
      <View style={{ padding: 12, gap: 8, backgroundColor: c.surface }}>
        <T size={13} muted>
          {spec?.description}
        </T>
        <T size={14}>{stateLine}</T>
        {downloading || partial ? (
          <View style={{ height: 6, borderRadius: 3, backgroundColor: c.border, overflow: "hidden" }}>
            <View style={{ width: `${pct}%`, height: 6, backgroundColor: c.accent }} />
          </View>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {downloading ? (
            <Button small variant="secondary" icon={Pause} title={t("lm.pause")} onPress={() => native.pauseDownload(m.id)} />
          ) : !usable && m.state !== "loading" ? (
            <Button small icon={Download} title={partial ? t("lm.resume") : t("lm.download")} disabled={m.ram === "block"} onPress={() => native.startDownload(m.id)} />
          ) : null}
          {usable || m.state === "loading" || partial || m.state === "error" ? <Button small variant="danger" icon={Trash2} title={t("lm.delete")} onPress={remove} /> : null}
        </View>
      </View>
      <ToggleRow title={t("lm.useInChain")} subtitle={t("lm.useInChainHint")} value={m.useInChain} onChange={onInChain} disabled={!usable && !m.useInChain} last={!usable} />
      {usable ? <TestPrompt native={native} model={m} /> : null}
    </Group>
  );
}

function TestPrompt({ native, model }: { native: Native; model: LocalModelStatus }) {
  const { t, locale } = useI18n();
  const { c } = useTheme();
  const font = useFont();
  const [prompt, setPrompt] = useState(locale === "he" ? "שלום! הצג את עצמך במשפט אחד." : "Hello! Introduce yourself in one sentence.");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<string | null>(null);
  const reqId = useRef<string | null>(null);

  useEffect(() => {
    const sub = native.addListener("onToken", (e) => {
      if (e.requestId !== reqId.current) return;
      if (e.delta) setOut((o) => o + e.delta);
      else if (e.phase) setMeta(t(`lm.phase.${e.phase}` as Parameters<typeof t>[0]));
    });
    return () => sub.remove();
  }, [native, t]);

  const run = async () => {
    if (busy) {
      if (reqId.current) native.cancel(reqId.current);
      return;
    }
    const id = `test-${Date.now()}`;
    reqId.current = id;
    setOut("");
    setMeta(null);
    setBusy(true);
    const started = Date.now();
    try {
      const r = await native.generate(id, model.id, "You are a helpful assistant. Answer briefly, in the language of the question.", [{ role: "user", content: prompt }], 512);
      setMeta(t("lm.testDone", { s: ((Date.now() - started) / 1000).toFixed(1), backend: r.backend.toUpperCase() }));
    } catch (e) {
      const err = e as { code?: string; message?: string };
      setMeta(err.code === "ERR_CANCELLED" ? t("lm.testStopped") : (err.message ?? String(e)));
    } finally {
      setBusy(false);
      reqId.current = null;
    }
  };

  return (
    <View style={{ padding: 12, gap: 8, backgroundColor: c.surface, borderTopWidth: 1, borderTopColor: c.border }}>
      <T size={13} weight="medium">
        {t("lm.test")}
      </T>
      <TextInput
        value={prompt}
        onChangeText={setPrompt}
        multiline
        style={{ fontFamily: font, fontSize: 14, color: c.fg, backgroundColor: c.bg, borderRadius: radii.sm, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: c.border, minHeight: 44 }}
      />
      <Button small variant={busy ? "secondary" : "primary"} icon={FlaskConical} title={busy ? t("lm.stop") : t("lm.run")} onPress={run} />
      {out ? <T size={14}>{out}</T> : null}
      {meta ? (
        <T size={12} muted>
          {meta}
        </T>
      ) : null}
    </View>
  );
}
