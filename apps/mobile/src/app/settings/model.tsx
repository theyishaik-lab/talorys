import * as Haptics from "expo-haptics";
import { ExternalLink, KeyRound, RefreshCw } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Linking, TextInput, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, RadioRow, Row } from "../../components/SettingsList";
import { Button, Chip, IconButton, T, useFont } from "../../components/ui";
import { ApiError, api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { radii, useTheme } from "../../lib/theme";

/** Shapes from the agent's /ai/models (feat/settings-models). Older agents 404 → the read-only fallback. */
interface CatalogModel {
  id: string;
  name: string;
  description: string;
  context: number | null;
  tools: boolean;
  free: boolean;
  speed: "fast" | "balanced" | "slow" | null;
  quality: "basic" | "good" | "best" | null;
  recommended?: boolean;
}
interface CatalogProvider {
  id: string;
  name: string;
  connected: boolean;
  keyHint: string | null;
  needsKey: boolean;
  keyUrl: string | null;
  models: CatalogModel[];
  error: string | null;
  source: "live" | "static";
}
interface ModelCatalog {
  providers: CatalogProvider[];
  current: { provider: string; model: string };
  keys_available?: boolean;
}

export default function ModelScreen() {
  const { c } = useTheme();
  const { t } = useI18n();
  const font = useFont();
  const [catalog, setCatalog] = useState<ModelCatalog | null | "unsupported">(null);
  const [current, setCurrent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setError(null);
    try {
      const cat = await api<ModelCatalog>(`/ai/models${refresh ? "?refresh=1" : ""}`);
      setCatalog(cat);
      setCurrent(cat.current.model);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setCatalog("unsupported");
        api<{ settings: { model?: string } }>("/settings")
          .then((r) => setCurrent(r.settings.model ?? ""))
          .catch(() => {});
      } else setError(e instanceof Error ? e.message : t("m.error.generic"));
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const choose = async (provider: CatalogProvider, model: CatalogModel) => {
    const before = current;
    setCurrent(model.id);
    try {
      await api("/settings", { method: "PATCH", body: { modelProvider: provider.id, model: model.id } });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setCurrent(before);
      setError(e instanceof Error ? e.message : t("m.error.generic"));
    }
  };

  const saveKey = async (provider: CatalogProvider) => {
    if (!keyValue.trim()) return;
    setBusy(provider.id);
    try {
      const r = await api<{ key: { hint: string } }>(`/ai/keys/${provider.id}`, { method: "PUT", body: { key: keyValue.trim() } });
      setKeyValue("");
      setKeyFor(null);
      Alert.alert(t("m.model.keySaved", { hint: r.key.hint }));
      await load(true);
    } catch (e) {
      Alert.alert(t("m.error.generic"), e instanceof Error ? e.message : "");
    } finally {
      setBusy(null);
    }
  };

  const testKey = async (provider: CatalogProvider) => {
    setBusy(provider.id);
    try {
      await api(`/ai/keys/${provider.id}/test`, { method: "POST", body: {} });
      Alert.alert(t("m.model.keyOk"));
    } catch (e) {
      Alert.alert(t("m.error.generic"), e instanceof Error ? e.message : "");
    } finally {
      setBusy(null);
    }
  };

  const removeKey = (provider: CatalogProvider) => {
    Alert.alert(t("m.model.removeKey"), provider.name, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: async () => {
          await api(`/ai/keys/${provider.id}`, { method: "DELETE" }).catch(() => {});
          load(true);
        },
      },
    ]);
  };

  const tags = (m: CatalogModel): string[] => {
    const out: string[] = [m.free ? t("m.model.free") : t("m.model.paid"), m.tools ? t("m.model.tools") : t("m.model.noTools")];
    if (m.speed) out.push(t(`m.model.${m.speed}` as "m.model.fast"));
    if (m.quality) out.push(t(`m.model.${m.quality}` as "m.model.good"));
    if (m.context) out.push(`${Math.round(m.context / 1000)}k`);
    return out;
  };

  return (
    <Screen title={t("settings.model")} right={catalog && catalog !== "unsupported" ? <IconButton icon={RefreshCw} label={t("common.retry")} onPress={() => load(true)} /> : undefined}>
      {error ? (
        <T size={13} color={c.danger}>
          {error}
        </T>
      ) : null}
      {catalog === null ? (
        <ActivityIndicator color={c.accent} />
      ) : catalog === "unsupported" ? (
        <Group title={t("m.model.current")} footer={t("m.model.readOnly")}>
          <Row title={current || "—"} last />
        </Group>
      ) : (
        catalog.providers.map((p) => (
          <Group
            key={p.id}
            title={p.name}
            footer={p.error ? p.error : p.needsKey && !p.connected ? undefined : undefined}
          >
            {p.needsKey ? (
              <View style={{ paddingHorizontal: 14, paddingVertical: 10, gap: 8, borderBottomWidth: 1, borderBottomColor: c.border }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <KeyRound size={16} color={c.fg2} />
                  <T size={13} muted style={{ flex: 1 }}>
                    {p.connected ? `${t("m.connections.connected")} ${p.keyHint ?? ""}` : t("m.connections.notConnected")}
                  </T>
                  {p.keyUrl ? <IconButton icon={ExternalLink} label={t("m.model.getKey")} size={32} onPress={() => Linking.openURL(p.keyUrl!).catch(() => {})} /> : null}
                </View>
                {keyFor === p.id ? (
                  <View style={{ gap: 8 }}>
                    <TextInput
                      value={keyValue}
                      onChangeText={setKeyValue}
                      placeholder={t("m.model.keyPlaceholder")}
                      placeholderTextColor={c.fgFaint}
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      style={{ fontFamily: font, fontSize: 15, color: c.fg, backgroundColor: c.bg, borderRadius: radii.sm, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: c.border }}
                    />
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <Button title={t("common.save")} small onPress={() => saveKey(p)} loading={busy === p.id} style={{ flex: 1 }} />
                      <Button title={t("common.cancel")} small variant="secondary" onPress={() => {
                        setKeyFor(null);
                        setKeyValue("");
                      }} style={{ flex: 1 }} />
                    </View>
                  </View>
                ) : (
                  <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                    <Button title={p.connected ? t("m.model.changeKey") : t("m.model.addKey")} small variant="secondary" onPress={() => setKeyFor(p.id)} />
                    {p.connected ? <Button title={t("m.model.keyTest")} small variant="secondary" onPress={() => testKey(p)} loading={busy === p.id} /> : null}
                    {p.connected ? <Button title={t("m.model.removeKey")} small variant="danger" onPress={() => removeKey(p)} /> : null}
                  </View>
                )}
              </View>
            ) : null}
            {p.models.map((m, i) => (
              <RadioRow
                key={m.id}
                title={m.name + (m.recommended ? " ★" : "")}
                subtitle={[m.description, tags(m).join(" · ")].filter(Boolean).join("\n")}
                selected={current === m.id}
                onPress={() => (p.connected ? choose(p, m) : setKeyFor(p.id))}
                last={i === p.models.length - 1}
              />
            ))}
            {p.models.length === 0 ? <Row title="—" last /> : null}
          </Group>
        ))
      )}
      {catalog && catalog !== "unsupported" ? (
        <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
          <Chip label={`${t("m.model.current")}: ${current.split("/").pop() ?? ""}`} />
        </View>
      ) : null}
    </Screen>
  );
}
