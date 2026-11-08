import { Globe, KeyRound, Pencil, Plus, Trash2 } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Switch, TextInput, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, ToggleRow } from "../../components/SettingsList";
import { Button, Icon, IconButton, Press, T, useFont } from "../../components/ui";
import { type ApiConnectionView, deleteApiConnection, isDraftReady, loadApiConnections, saveApiConnection, setHttpSettings } from "../../lib/apiConnections";
import { useI18n } from "../../lib/i18n";
import { radii, useTheme } from "../../lib/theme";
import type { ApiConnectionsResponse } from "@talorys/shared";

/**
 * Settings → API connections (חיבורי API): the APIs the agent's http_request tool may call with a
 * saved key, and whether changing requests (POST/PUT/PATCH/DELETE) wait for Approve in the chat.
 * Same API as the web screen; the key is sent once and only its last four characters come back.
 */
export default function ApiConnectionsScreen() {
  const { c } = useTheme();
  const { t } = useI18n();
  const [data, setData] = useState<ApiConnectionsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ApiConnectionView | "new" | null>(null);

  const reload = useCallback(async () => {
    try {
      setData(await loadApiConnections());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    Promise.resolve().then(reload);
  }, [reload]);

  const toggleConfirm = async (v: boolean) => {
    if (!data) return;
    setData({ ...data, settings: { ...data.settings, confirmNonGet: v } });
    try {
      await setHttpSettings({ confirmNonGet: v });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await reload();
    }
  };

  const confirmDelete = (x: ApiConnectionView) =>
    Alert.alert(t("http.deleteTitle"), t("http.deleteMessage", { name: x.name }), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: async () => {
          await deleteApiConnection(x.id).catch((e) => setError(e instanceof Error ? e.message : String(e)));
          reload();
        },
      },
    ]);

  const group = { backgroundColor: c.surface, borderRadius: radii.md, overflow: "hidden" as const, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border };

  return (
    <Screen title={t("settings.tab.Api")}>
      <T size={13} muted style={{ paddingHorizontal: 4 }}>
        {t("http.intro")}
      </T>
      {error ? (
        <T size={13} color={c.danger}>
          {error}
        </T>
      ) : null}
      {data === null ? (
        <ActivityIndicator color={c.accent} />
      ) : (
        <>
          <View style={{ gap: 6 }}>
            <T size={12} weight="medium" muted style={{ paddingHorizontal: 12 }}>
              {t("http.list")}
            </T>
            <View style={group}>
              {data.connections.length === 0 ? (
                <T size={13} muted style={{ padding: 14 }}>
                  {t("http.none")}
                </T>
              ) : (
                data.connections.map((x) => (
                  <View key={x.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
                    <Icon icon={Globe} size={20} color={c.fg2} />
                    <View style={{ flex: 1, gap: 1 }}>
                      <T size={15} numberOfLines={1}>
                        {x.name}
                      </T>
                      <T size={12} muted numberOfLines={1} style={{ writingDirection: "ltr" }}>
                        {x.baseURL}
                      </T>
                      <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                        <Icon icon={KeyRound} size={11} color={c.fgFaint} />
                        <T size={11} color={c.fgFaint} numberOfLines={1}>
                          {x.secret.set ? `${x.authHeader} · ${x.secret.hint ?? ""}` : t("http.noSecret")}
                        </T>
                      </View>
                    </View>
                    <IconButton icon={Pencil} label={`${t("http.edit")} ${x.name}`} size={36} onPress={() => setEditing(x)} />
                    <IconButton icon={Trash2} label={`${t("common.delete")} ${x.name}`} size={36} color={c.danger} onPress={() => confirmDelete(x)} />
                  </View>
                ))
              )}
              <Press onPress={() => setEditing("new")} scale={0.99} style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 12, minHeight: 52 }}>
                <Icon icon={Plus} size={20} color={c.accent} />
                <T size={15} color={c.accent}>
                  {t("http.add")}
                </T>
              </Press>
            </View>
          </View>
          {!data.secrets_available ? (
            <T size={12} color={c.danger}>
              {t("http.secretsUnavailable")}
            </T>
          ) : null}
          <Group title={t("http.safety")} footer={t("http.guard")}>
            <ToggleRow title={t("http.confirm")} subtitle={t("http.confirmHint")} value={data.settings.confirmNonGet} onChange={toggleConfirm} last />
          </Group>
        </>
      )}
      <ConnectionSheet
        key={editing === "new" ? "new" : (editing?.id ?? "none")}
        connection={editing}
        secretsAvailable={data?.secrets_available ?? true}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          setEditing(null);
          await reload();
        }}
      />
    </Screen>
  );
}

function ConnectionSheet({ connection, secretsAvailable, onClose, onSaved }: { connection: ApiConnectionView | "new" | null; secretsAvailable: boolean; onClose: () => void; onSaved: () => void }) {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const font = useFont();
  const existing = connection && connection !== "new" ? connection : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "https://");
  const [authHeader, setAuthHeader] = useState(existing?.authHeader ?? "Authorization");
  const [secret, setSecret] = useState("");
  const [removeSecret, setRemoveSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = isDraftReady({ name, baseURL, authHeader });
  const input = { fontFamily: font, fontSize: 15, color: c.fg, backgroundColor: c.surface, borderRadius: radii.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border, paddingHorizontal: 12, paddingVertical: 10 };
  const ltr = { ...input, textAlign: "left" as const, writingDirection: "ltr" as const };
  const label = (text: string) => (
    <T size={13} weight="medium">
      {text}
    </T>
  );

  return (
    <Modal visible={connection !== null} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Pressable style={{ flex: 1, backgroundColor: c.scrim, padding: 20, paddingTop: 70 }} onPress={onClose}>
        <Pressable style={{ backgroundColor: c.elev, borderRadius: radii.lg, padding: 18, gap: 10 }}>
          <T weight="semibold" size={17}>
            {existing ? t("http.edit") : t("http.add")}
          </T>
          {label(t("http.name"))}
          <TextInput value={name} onChangeText={setName} placeholder={t("http.namePlaceholder")} placeholderTextColor={c.fgFaint} maxLength={60} style={{ ...input, textAlign: rtl ? "right" : "left" }} />
          {label(t("http.baseURL"))}
          <TextInput value={baseURL} onChangeText={setBaseURL} placeholder="https://api.example.com/v1" placeholderTextColor={c.fgFaint} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={ltr} />
          {baseURL.trim() && !baseURL.trim().startsWith("https://") ? (
            <T size={12} color={c.danger}>
              {t("http.httpsOnly")}
            </T>
          ) : null}
          {label(t("http.authHeader"))}
          <TextInput value={authHeader} onChangeText={setAuthHeader} placeholder="Authorization" placeholderTextColor={c.fgFaint} autoCapitalize="none" autoCorrect={false} style={ltr} />
          {label(t("http.secret"))}
          <TextInput
            value={secret}
            onChangeText={setSecret}
            placeholder={existing?.secret.set ? (existing.secret.hint ?? "") : "Bearer …"}
            placeholderTextColor={c.fgFaint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={secretsAvailable && !removeSecret}
            style={ltr}
          />
          <T size={12} muted>
            {existing?.secret.set ? t("http.secretKeep", { hint: existing.secret.hint ?? "" }) : t("http.secretHint")}
          </T>
          {existing?.secret.set ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Switch value={removeSecret} onValueChange={setRemoveSecret} trackColor={{ true: c.danger, false: c.borderStrong }} thumbColor={c.bg} />
              <T size={13}>{t("http.secretRemove")}</T>
            </View>
          ) : null}
          {error ? (
            <T size={13} color={c.danger}>
              {error}
            </T>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
            <Button title={t("common.cancel")} small variant="ghost" onPress={onClose} />
            <Button
              title={t("common.save")}
              small
              loading={busy}
              disabled={!ready}
              onPress={async () => {
                setBusy(true);
                setError(null);
                try {
                  await saveApiConnection(existing?.id ?? null, { name, baseURL, authHeader, secret: removeSecret ? null : secret });
                  setSecret("");
                  onSaved();
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
