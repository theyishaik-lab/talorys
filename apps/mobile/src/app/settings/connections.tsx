import type { ConnectField } from "@talorys/shared";
import * as WebBrowser from "expo-web-browser";
import { Search, Unplug } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Image, Modal, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Button, Icon, T, useFont } from "../../components/ui";
import { ApiError } from "../../lib/api";
import { type CatalogService, type ConnectPlan, type ConnectedService, connectService, connectionPlan, connectionStatus, disconnect, filterCatalog, loadCatalog, loadConnections } from "../../lib/connections";
import { useI18n } from "../../lib/i18n";
import { radii, useTheme } from "../../lib/theme";

const POLL_MS = 2_000;
const POLL_MAX_MS = 60_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Polls the agent until the service shows up as connected (after an OAuth sign-in in the browser). */
async function pollConnected(service: string): Promise<boolean> {
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    try {
      if ((await connectionStatus(service)).connected) return true;
    } catch {
      /* keep trying */
    }
    await sleep(POLL_MS);
  }
  return false;
}

/** The service's logo from the catalog, or its initial on a tinted tile. */
const Logo = memo(function Logo({ uri, name, size = 32 }: { uri?: string | null; name: string; size?: number }) {
  const { c } = useTheme();
  const [failed, setFailed] = useState(false);
  if (uri && !failed) {
    return (
      <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>
        <Image source={{ uri }} style={{ width: size - 10, height: size - 10 }} onError={() => setFailed(true)} accessibilityIgnoresInvertColors />
      </View>
    );
  }
  return (
    <View style={{ width: size, height: size, borderRadius: 8, backgroundColor: c.accentSoft, alignItems: "center", justifyContent: "center" }}>
      <T weight="semibold" size={14} color={c.accentText}>
        {name.slice(0, 1).toUpperCase()}
      </T>
    </View>
  );
});

/**
 * Connections (OpenConnector): what is connected (account, Disconnect) and every supported service
 * (search, Connect). OAuth opens the provider's sign-in in a browser tab; when it closes, the screen
 * polls the agent until the connection shows up. Key-based services get a secure form; the key goes
 * to the agent and on to the connector, and is never shown again.
 */
export default function ConnectionsScreen() {
  const { c } = useTheme();
  const { t, locale, rtl } = useI18n();
  const font = useFont();
  const [connected, setConnected] = useState<ConnectedService[] | null>(null);
  const [catalog, setCatalog] = useState<CatalogService[]>([]);
  const [configured, setConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [keyPlan, setKeyPlan] = useState<ConnectPlan | null>(null);

  const reload = useCallback(async () => {
    try {
      const [conn, cat] = await Promise.all([loadConnections(), loadCatalog()]);
      setConfigured(conn.configured && cat.configured);
      setConnected(conn.connections);
      setCatalog(cat.services);
      setError(conn.error ?? null);
    } catch (e) {
      setConnected((x) => x ?? []);
      setError(e instanceof Error ? e.message : "Failed");
    }
  }, []);
  useEffect(() => {
    Promise.resolve().then(reload);
  }, [reload]);

  const byId = useMemo(() => new Map(catalog.map((s) => [s.id, s])), [catalog]);
  const nameOf = useCallback((id: string) => {
    const s = byId.get(id);
    return s ? (locale === "he" && s.he ? s.he : s.name) : id;
  }, [byId, locale]);
  const connectedIds = useMemo(() => new Set((connected ?? []).map((x) => x.service)), [connected]);
  const supported = useMemo(() => filterCatalog(catalog, connectedIds, query), [catalog, connectedIds, query]);

  const waitForConnection = async (service: string) => {
    setStatus(t("conn.waiting"));
    if (await pollConnected(service)) {
      setStatus(t("conn.done", { name: nameOf(service) }));
      await reload();
    } else setStatus(t("conn.notYet"));
  };

  const connect = async (service: string) => {
    setBusy(service);
    setStatus(null);
    try {
      const plan = await connectionPlan(service);
      if (plan.method === "oauth") {
        if (!plan.oauth_ready) {
          Alert.alert(plan.name, t("conn.needsSetup"));
          return;
        }
        const { authorization_url } = await connectService(service);
        if (!authorization_url) throw new Error("No sign-in link");
        setStatus(t("conn.signInHint"));
        await WebBrowser.openBrowserAsync(authorization_url, { showTitle: true, enableBarCollapsing: true });
        await waitForConnection(service);
      } else {
        setKeyPlan(plan);
      }
    } catch (e) {
      setStatus(t("conn.failed", { error: e instanceof ApiError || e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(null);
    }
  };

  const confirmDisconnect = (x: ConnectedService) =>
    Alert.alert(t("conn.disconnect"), t("conn.disconnectConfirm", { name: nameOf(x.service) }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("conn.disconnect"),
        style: "destructive",
        onPress: async () => {
          setBusy(x.service);
          await disconnect(x.service).catch((e) => setStatus(t("conn.failed", { error: e instanceof Error ? e.message : String(e) })));
          setBusy(null);
          reload();
        },
      },
    ]);

  const group = { backgroundColor: c.surface, borderRadius: radii.md, overflow: "hidden" as const, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border };
  const rowStyle = (last: boolean) => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 56, borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth, borderBottomColor: c.border });
  const heading = (text: string) => (
    <T size={12} weight="medium" muted style={{ paddingHorizontal: 12, textTransform: "uppercase", letterSpacing: 0.6 }}>
      {text}
    </T>
  );

  return (
    <Screen title={t("conn.title")}>
      {connected === null ? (
        <ActivityIndicator color={c.accent} />
      ) : !configured ? (
        <T muted>{t("conn.notConfigured")}</T>
      ) : (
        <>
          {status ? (
            <View style={{ backgroundColor: c.accentSoft, borderRadius: radii.md, padding: 12, gap: 8 }}>
              <T size={13}>{status}</T>
            </View>
          ) : null}
          {error ? (
            <T size={13} color={c.danger}>
              {error}
            </T>
          ) : null}

          <View style={{ gap: 6 }}>
            {heading(t("conn.connected"))}
            {connected.length === 0 ? (
              <T size={13} muted style={{ paddingHorizontal: 12 }}>
                {t("conn.noneConnected")}
              </T>
            ) : (
              <View style={group}>
                {connected.map((x, i) => (
                  <View key={x.service} style={rowStyle(i === connected.length - 1)}>
                    <Logo uri={byId.get(x.service)?.logo} name={nameOf(x.service)} />
                    <View style={{ flex: 1, gap: 1 }}>
                      <T size={15}>{nameOf(x.service)}</T>
                      <T size={12} muted numberOfLines={1}>
                        {x.account ? t("conn.account", { account: x.account }) : t("m.connections.connected")}
                      </T>
                    </View>
                    <Button title={t("conn.disconnect")} small variant="ghost" icon={Unplug} loading={busy === x.service} onPress={() => confirmDisconnect(x)} />
                  </View>
                ))}
              </View>
            )}
          </View>

          <View style={{ gap: 6 }}>
            {heading(t("conn.supported"))}
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: c.surface2, borderRadius: radii.sm, paddingHorizontal: 10 }}>
              <Icon icon={Search} size={16} color={c.fgMuted} />
              <TextInput value={query} onChangeText={setQuery} placeholder={t("conn.search")} placeholderTextColor={c.fgFaint} autoCorrect={false} autoCapitalize="none" style={{ flex: 1, fontFamily: font, fontSize: 14, color: c.fg, paddingVertical: 9, textAlign: rtl ? "right" : "left" }} />
            </View>
            {supported.length === 0 ? (
              <T size={13} muted style={{ paddingHorizontal: 12, paddingTop: 6 }}>
                {t("conn.noMatches")}
              </T>
            ) : (
              <View style={group}>
                {supported.map((s, i) => (
                  <View key={s.id} style={rowStyle(i === supported.length - 1)}>
                    <Logo uri={s.logo} name={nameOf(s.id)} />
                    <T size={15} style={{ flex: 1 }} numberOfLines={1}>
                      {nameOf(s.id)}
                    </T>
                    <Button title={t("conn.connect")} small variant="secondary" loading={busy === s.id} disabled={busy !== null && busy !== s.id} onPress={() => connect(s.id)} />
                  </View>
                ))}
              </View>
            )}
          </View>
        </>
      )}
      <KeyDialog
        plan={keyPlan}
        onClose={() => setKeyPlan(null)}
        onConnected={async (name) => {
          setKeyPlan(null);
          setStatus(t("conn.done", { name }));
          await reload();
        }}
      />
    </Screen>
  );
}

/** The fields of a key-based service (from the connector's catalog), typed into secure inputs. */
function KeyDialog({ plan, onClose, onConnected }: { plan: ConnectPlan | null; onClose: () => void; onConnected: (name: string) => void }) {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const font = useFont();
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fields: ConnectField[] = plan?.fields ?? [];
  const ready = fields.every((f) => f.required === false || (values[f.key] ?? "").trim());
  return (
    <Modal visible={!!plan} transparent animationType="fade" onRequestClose={onClose} onShow={() => { setValues({}); setError(null); }} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: c.scrim, padding: 24, paddingTop: 100 }} onPress={onClose}>
        <Pressable style={{ backgroundColor: c.elev, borderRadius: radii.lg, padding: 18, gap: 12 }}>
          <T weight="semibold" size={17}>
            {t("conn.keyTitle", { name: plan?.name ?? "" })}
          </T>
          {fields.map((f) => (
            <View key={f.key} style={{ gap: 4 }}>
              <T size={13} weight="medium">
                {f.label}
              </T>
              <TextInput
                value={values[f.key] ?? ""}
                onChangeText={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))}
                placeholder={f.placeholder}
                placeholderTextColor={c.fgFaint}
                secureTextEntry={f.secret !== false}
                autoCapitalize="none"
                autoCorrect={false}
                style={{ fontFamily: font, fontSize: 15, color: c.fg, backgroundColor: c.surface, borderRadius: radii.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 10, textAlign: rtl ? "right" : "left" }}
              />
              {f.hint ? (
                <T size={12} muted>
                  {f.hint}
                </T>
              ) : null}
            </View>
          ))}
          <T size={12} muted>
            {t("m.connect.keyHint")}
          </T>
          {error ? (
            <T size={13} color={c.danger}>
              {error}
            </T>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button title={t("common.cancel")} small variant="ghost" onPress={onClose} />
            <Button
              title={t("conn.save")}
              small
              loading={busy}
              disabled={!ready}
              onPress={async () => {
                if (!plan) return;
                setBusy(true);
                setError(null);
                try {
                  await connectService(plan.service, values);
                  setValues({});
                  onConnected(plan.name);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            />
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
