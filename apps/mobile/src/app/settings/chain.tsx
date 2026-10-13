import * as Haptics from "expo-haptics";
import {
  type AiProviderId,
  type ChainRef,
  type ChainStatus,
  type ChainStatusEntry,
  endpointIdFromName,
  MAX_FALLBACK_CHAIN,
  modelLabel,
  moveItem,
  settingsPatchForChain,
} from "@talorys/shared";
import { ChevronDown, ChevronUp, Plus, RefreshCw, RotateCcw, Server, Trash2, X } from "lucide-react-native";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Modal, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, Row } from "../../components/SettingsList";
import { Button, IconButton, Press, T, useFont } from "../../components/ui";
import { api } from "../../lib/api";
import { quotaLine, stateText } from "../../lib/chain-view";
import { useI18n } from "../../lib/i18n";
import { radii, useTheme } from "../../lib/theme";

const MAX_ENTRIES = MAX_FALLBACK_CHAIN + 2;
const refKey = (r: ChainRef) => `${r.provider}|${r.model}`;

interface CatalogProvider {
  id: AiProviderId;
  name: string;
  connected: boolean;
  needsKey: boolean;
  models: { id: string; name: string }[];
}
interface EndpointInfo {
  id: string;
  name: string;
}

/**
 * Settings → Model → Model chain: every model in the fallback chain, in order, with its live state and
 * the quota left where the provider tells. Reorder with the arrows, remove, add from any provider or a
 * new OpenAI-compatible endpoint; "Save order" writes it (PATCH /settings). Same API as the web screen.
 */
export default function ChainScreen() {
  const { c } = useTheme();
  const { t } = useI18n();
  const [status, setStatus] = useState<ChainStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChainRef[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointInfo[]>([]);
  const [picker, setPicker] = useState(false);
  const [epForm, setEpForm] = useState(false);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [s, cat, eps] = await Promise.all([
        api<ChainStatus>("/ai/chain"),
        api<{ providers: CatalogProvider[] }>("/ai/models").catch(() => ({ providers: [] })),
        api<{ endpoints: EndpointInfo[] }>("/ai/endpoints").catch(() => ({ endpoints: [] })),
      ]);
      setStatus(s);
      setProviders(cat.providers);
      setEndpoints(eps.endpoints);
    } catch (e) {
      setError(t("m.chain.loadError", { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [t]);

  useEffect(() => {
    Promise.resolve().then(() => load());
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const stored = useMemo(() => (status?.entries ?? []).map((e) => ({ provider: e.provider, model: e.model })), [status]);
  const byKey = useMemo(() => new Map((status?.entries ?? []).map((e) => [refKey(e), e])), [status]);
  const list = draft ?? stored;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(stored);

  const add = (ref: ChainRef) => {
    if (list.some((r) => refKey(r) === refKey(ref))) return;
    if (list.length >= MAX_ENTRIES) return Alert.alert(t("m.chain.full", { n: MAX_ENTRIES }));
    setDraft([...list, ref]);
  };

  const save = async () => {
    setSaving(true);
    try {
      await api("/settings", { method: "PATCH", body: settingsPatchForChain(list) });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setDraft(null);
      await load();
    } catch (e) {
      Alert.alert(t("m.chain.saveFailed"), e instanceof Error ? e.message : "");
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = async (enabled: boolean) => {
    try {
      await api("/settings", { method: "PATCH", body: { fallback: { enabled } } });
      await load();
    } catch (e) {
      Alert.alert(t("m.chain.saveFailed"), e instanceof Error ? e.message : "");
    }
  };

  const clearPauses = async () => {
    await api("/ai/cooldowns", { method: "DELETE" }).catch(() => {});
    Alert.alert(t("m.chain.cleared"));
    load();
  };

  const anyPaused = (status?.entries ?? []).some((e) => e.state === "paused" || e.state === "exhausted");

  return (
    <Screen title={t("m.chain.title")} right={<IconButton icon={RefreshCw} label={t("m.chain.refresh")} onPress={() => load()} />}>
      {error ? (
        <T size={13} color={c.danger}>
          {error}
        </T>
      ) : null}
      {status === null && !error ? <ActivityIndicator color={c.accent} /> : null}
      {status ? (
        <>
          <Group footer={status.enabled ? t("m.chain.hint") : t("m.chain.off")}>
            <Row
              title={t("m.chain.enable")}
              subtitle={t("m.chain.count", { n: list.length })}
              last
              right={<Switch value={status.enabled} onValueChange={setEnabled} trackColor={{ true: c.accent, false: c.borderStrong }} thumbColor={c.bg} />}
            />
          </Group>
          <Group title={t("m.chain.title")}>
            {list.map((ref, i) => (
              <ChainRow
                key={refKey(ref)}
                index={i}
                entry={byKey.get(refKey(ref)) ?? null}
                chainRef={ref}
                dimmed={!status.enabled && i > 0}
                last={i === list.length - 1}
                onUp={i > 0 ? () => setDraft(moveItem(list, i, i - 1)) : undefined}
                onDown={i < list.length - 1 ? () => setDraft(moveItem(list, i, i + 1)) : undefined}
                onRemove={() => (list.length <= 1 ? Alert.alert(t("m.chain.empty")) : setDraft(list.filter((_, j) => j !== i)))}
              />
            ))}
          </Group>
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button title={t("m.chain.add")} icon={Plus} small variant="secondary" onPress={() => setPicker(true)} disabled={list.length >= MAX_ENTRIES} />
            <Button title={t("m.chain.addEndpoint")} icon={Server} small variant="secondary" onPress={() => setEpForm(true)} disabled={list.length >= MAX_ENTRIES} />
            {anyPaused && !dirty ? <Button title={t("m.chain.clearPauses")} icon={RotateCcw} small variant="ghost" onPress={clearPauses} /> : null}
          </View>
          {dirty ? (
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center", padding: 12, borderRadius: radii.md, backgroundColor: c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>
              <T size={13} muted style={{ flex: 1 }}>
                {t("m.chain.unsaved")}
              </T>
              <Button title={t("m.chain.discard")} small variant="ghost" onPress={() => setDraft(null)} />
              <Button title={t("m.chain.save")} small onPress={save} loading={saving} />
            </View>
          ) : null}
        </>
      ) : null}
      <AddModelSheet open={picker} onClose={() => setPicker(false)} providers={providers} endpoints={endpoints} list={list} onAdd={add} />
      <EndpointSheet
        open={epForm}
        onClose={() => setEpForm(false)}
        taken={endpoints.map((e) => e.id)}
        onAdded={(ref, name) => {
          add(ref);
          setEndpoints((eps) => [...eps, { id: ref.model.split("/")[0] ?? "", name }]);
          Alert.alert(t("m.chain.ep.saved", { name }));
        }}
      />
    </Screen>
  );
}

function ChainRow({
  index,
  entry,
  chainRef,
  dimmed,
  last,
  onUp,
  onDown,
  onRemove,
}: {
  index: number;
  entry: ChainStatusEntry | null;
  chainRef: ChainRef;
  dimmed: boolean;
  last: boolean;
  onUp?: () => void;
  onDown?: () => void;
  onRemove: () => void;
}) {
  const { c } = useTheme();
  const { t } = useI18n();
  const state = entry?.state ?? "available";
  const dot = state === "available" ? c.success : state === "paused" ? c.warning : state === "exhausted" ? c.danger : c.fgFaint;
  return (
    <View style={{ flexDirection: "row", gap: 10, paddingHorizontal: 12, paddingVertical: 10, alignItems: "center", opacity: dimmed ? 0.55 : 1, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
      <T size={12} weight="medium" muted style={{ width: 18, textAlign: "center" }}>
        {index + 1}
      </T>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <T size={15} weight="medium" style={{ writingDirection: "ltr" }} numberOfLines={2}>
            {entry?.label ?? (modelLabel(chainRef.model) || chainRef.model)}
          </T>
          <T size={12} muted>
            {entry?.provider_label ?? chainRef.provider}
          </T>
          {index === 0 ? (
            <View style={{ backgroundColor: c.accentSoft, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 1 }}>
              <T size={11} color={c.accentText}>
                {t("m.chain.primary")}
              </T>
            </View>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
          <T size={12} color={c.fg2} style={{ flex: 1 }}>
            {entry ? stateText(t, entry) : t("m.chain.state.available")}
          </T>
        </View>
        <T size={11.5} muted>
          {entry ? quotaLine(t, entry.quota) : t("m.chain.quota.unknown")}
        </T>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <SmallIcon icon={ChevronUp} label={t("m.chain.moveUp")} onPress={onUp} />
        <SmallIcon icon={ChevronDown} label={t("m.chain.moveDown")} onPress={onDown} />
        <SmallIcon icon={Trash2} label={t("m.chain.remove")} onPress={onRemove} danger />
      </View>
    </View>
  );
}

function SmallIcon({ icon: I, label, onPress, danger }: { icon: typeof ChevronUp; label: string; onPress?: () => void; danger?: boolean }) {
  const { c } = useTheme();
  return (
    <Press onPress={onPress} disabled={!onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={4} style={{ width: 34, height: 34, alignItems: "center", justifyContent: "center", opacity: onPress ? 1 : 0.3 }}>
      <I size={18} color={danger ? c.danger : c.fg2} />
    </Press>
  );
}

function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const { c } = useTheme();
  const { t } = useI18n();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" }}>
        <View style={{ backgroundColor: c.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: "85%", paddingBottom: 24 }}>
          <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 }}>
            <T size={17} weight="semibold" style={{ flex: 1 }}>
              {title}
            </T>
            <IconButton icon={X} label={t("common.close")} onPress={onClose} size={36} />
          </View>
          {children}
        </View>
      </View>
    </Modal>
  );
}

function Field({ value, onChangeText, placeholder, secure, ltr }: { value: string; onChangeText: (v: string) => void; placeholder?: string; secure?: boolean; ltr?: boolean }) {
  const { c } = useTheme();
  const font = useFont();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={c.fgFaint}
      secureTextEntry={secure}
      autoCapitalize="none"
      autoCorrect={false}
      style={{ fontFamily: font, fontSize: 15, color: c.fg, backgroundColor: c.surface, borderRadius: radii.sm, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: c.border, writingDirection: ltr ? "ltr" : undefined, textAlign: ltr ? "left" : undefined }}
    />
  );
}

function AddModelSheet({ open, onClose, providers, endpoints, list, onAdd }: { open: boolean; onClose: () => void; providers: CatalogProvider[]; endpoints: EndpointInfo[]; list: ChainRef[]; onAdd: (r: ChainRef) => void }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const sources = [...providers.map((p) => ({ key: `p:${p.id}`, label: p.name })), ...endpoints.map((e) => ({ key: `e:${e.id}`, label: e.name }))];
  const [source, setSource] = useState<string>("");
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [epModels, setEpModels] = useState<{ models: string[]; error: string | null } | null>(null);
  const chosen = source || sources[0]?.key || "";
  const isEndpoint = chosen.startsWith("e:");
  const id = chosen.slice(2);

  useEffect(() => {
    if (!open || !isEndpoint) return;
    let live = true;
    Promise.resolve()
      .then(() => {
        setEpModels(null);
        return api<{ models: string[]; error: string | null }>(`/ai/endpoints/${id}/models`);
      })
      .then((r) => live && setEpModels(r))
      .catch((e) => live && setEpModels({ models: [], error: e instanceof Error ? e.message : String(e) }));
    return () => {
      live = false;
    };
  }, [open, isEndpoint, id]);

  const provider = providers.find((p) => p.id === id);
  const models = isEndpoint
    ? (epModels?.models ?? []).map((m) => ({ id: m, name: modelLabel(m) || m, ref: { provider: "openai-compatible" as const, model: `${id}/${m}` } }))
    : (provider?.models ?? []).map((m) => ({ id: m.id, name: m.name, ref: { provider: id as AiProviderId, model: m.id } }));
  const q = query.trim().toLowerCase();
  const shown = q ? models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)) : models;
  const inChain = new Set(list.map(refKey));
  const pick = (r: ChainRef) => {
    onAdd(r);
    setQuery("");
    setManual("");
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title={t("m.chain.pick.title")}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingHorizontal: 16, paddingVertical: 6 }}>
        {sources.map((s) => (
          <Press key={s.key} onPress={() => setSource(s.key)} style={{ paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: chosen === s.key ? c.fg : c.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>
            <T size={13} color={chosen === s.key ? c.bg : c.fg}>
              {s.label}
            </T>
          </Press>
        ))}
      </ScrollView>
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        {provider?.needsKey && !provider.connected ? (
          <T size={12} color={c.warning}>
            {t("m.chain.pick.noKey")}
          </T>
        ) : null}
        <Field value={query} onChangeText={setQuery} placeholder={t("m.chain.pick.search")} ltr />
      </View>
      <ScrollView style={{ maxHeight: 340 }} contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8 }}>
        {isEndpoint && epModels === null ? <ActivityIndicator color={c.accent} /> : null}
        {shown.length === 0 && !(isEndpoint && epModels === null) ? (
          <T size={13} muted>
            {epModels?.error ?? t("m.chain.pick.noModels")}
          </T>
        ) : null}
        {shown.map((m) => {
          const already = inChain.has(refKey(m.ref));
          return (
            <Press key={m.id} disabled={already} onPress={() => pick(m.ref)} style={{ paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border, flexDirection: "row", alignItems: "center", gap: 8, opacity: already ? 0.5 : 1 }}>
              <View style={{ flex: 1 }}>
                <T size={15} style={{ writingDirection: "ltr" }} numberOfLines={1}>
                  {m.name}
                </T>
                <T size={11.5} muted style={{ writingDirection: "ltr" }} numberOfLines={1}>
                  {m.id}
                </T>
              </View>
              {already ? (
                <T size={12} muted>
                  {t("m.chain.pick.inChain")}
                </T>
              ) : (
                <Plus size={18} color={c.accent} />
              )}
            </Press>
          );
        })}
      </ScrollView>
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Field value={manual} onChangeText={setManual} placeholder={t("m.chain.pick.manual")} ltr />
        </View>
        <Button
          title={t("m.chain.pick.add")}
          small
          disabled={!manual.trim() || !chosen}
          onPress={() => pick(isEndpoint ? { provider: "openai-compatible", model: `${id}/${manual.trim()}` } : { provider: id as AiProviderId, model: manual.trim() })}
        />
      </View>
    </Sheet>
  );
}

function EndpointSheet({ open, onClose, taken, onAdded }: { open: boolean; onClose: () => void; taken: string[]; onAdded: (ref: ChainRef, name: string) => void }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const https = baseURL.trim() === "" || baseURL.trim().startsWith("https://");
  const ready = !!name.trim() && baseURL.trim().startsWith("https://") && !!model.trim();

  const submit = async () => {
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
    } catch (e) {
      Alert.alert(t("m.chain.saveFailed"), e instanceof Error ? e.message : "");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={t("m.chain.ep.title")}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 16, gap: 10, paddingBottom: 8 }} keyboardShouldPersistTaps="handled">
        <T size={12.5} muted>
          {t("m.chain.ep.hint")}
        </T>
        <T size={13} weight="medium">
          {t("m.chain.ep.name")}
        </T>
        <Field value={name} onChangeText={setName} placeholder="Z.ai" />
        <T size={13} weight="medium">
          {t("m.chain.ep.baseURL")}
        </T>
        <Field value={baseURL} onChangeText={setBaseURL} placeholder="https://api.example.com/v1" ltr />
        {!https ? (
          <T size={12} color={c.danger}>
            {t("m.chain.ep.httpsOnly")}
          </T>
        ) : null}
        <T size={13} weight="medium">
          {t("m.chain.ep.key")}
        </T>
        <Field value={key} onChangeText={setKey} secure ltr />
        <T size={13} weight="medium">
          {t("m.chain.ep.model")}
        </T>
        <Field value={model} onChangeText={setModel} placeholder="glm-4.7-flash" ltr />
        <Button title={t("m.chain.ep.save")} onPress={submit} loading={busy} disabled={!ready} />
      </ScrollView>
    </Sheet>
  );
}
