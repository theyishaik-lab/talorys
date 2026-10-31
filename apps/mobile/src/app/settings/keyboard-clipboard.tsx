import { useFocusEffect } from "expo-router";
import { Pin, PinOff, Trash2 } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Alert, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, Row } from "../../components/SettingsList";
import { Button, IconButton, T } from "../../components/ui";
import { type ClipItem, TalorysKeyboard } from "../../../modules/talorys-keyboard";
import { firstStrongDirection, useI18n } from "../../lib/i18n";
import { useTheme } from "../../lib/theme";

/** Settings → Keyboard → Clipboard history: what the keyboard kept (encrypted on the phone), pin / delete / clear. */
export default function KeyboardClipboardScreen() {
  const { c } = useTheme();
  const { t } = useI18n();
  const native = TalorysKeyboard;
  const [items, setItems] = useState<ClipItem[]>([]);

  const load = useCallback(() => {
    if (native) setItems(native.getClipboard());
  }, [native]);
  useFocusEffect(load);

  if (!native) {
    return (
      <Screen title={t("kb.clip.view")}>
        <T muted>{t("kb.unavailable")}</T>
      </Screen>
    );
  }

  const clear = (includePinned: boolean) =>
    Alert.alert(t(includePinned ? "kb.clip.clearAll" : "kb.clip.clear"), t("kb.clip.clearConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t(includePinned ? "kb.clip.clearAll" : "kb.clip.clear"),
        style: "destructive",
        onPress: () => {
          native.clearClipboard(includePinned);
          load();
        },
      },
    ]);

  return (
    <Screen title={t("kb.clip.view")}>
      {items.length === 0 ? (
        <T muted>{t("kb.clip.empty")}</T>
      ) : (
        <Group footer={t("kb.clip.hint")}>
          {items.map((it, i) => (
            <Row
              key={it.id}
              title={it.text.length > 160 ? `${it.text.slice(0, 160)}…` : it.text}
              subtitle={new Date(it.time).toLocaleString() + (it.pinned ? ` · ${t("kb.clip.pinned")}` : "")}
              last={i === items.length - 1}
              right={
                <View style={{ flexDirection: "row" }}>
                  <IconButton
                    icon={it.pinned ? PinOff : Pin}
                    color={it.pinned ? c.accent : c.fg2}
                    label={t(it.pinned ? "kb.clip.unpin" : "kb.clip.pin")}
                    onPress={() => {
                      native.pinClip(it.id, !it.pinned);
                      load();
                    }}
                  />
                  <IconButton
                    icon={Trash2}
                    label={t("kb.clip.delete")}
                    onPress={() => {
                      native.deleteClip(it.id);
                      load();
                    }}
                  />
                </View>
              }
            />
          ))}
        </Group>
      )}
      {items.length ? (
        <View style={{ gap: 8 }}>
          <Button title={t("kb.clip.clear")} variant="secondary" onPress={() => clear(false)} />
          {items.some((x) => x.pinned) ? <Button title={t("kb.clip.clearAll")} variant="danger" onPress={() => clear(true)} /> : null}
        </View>
      ) : null}
      {items.length ? (
        <T size={12} muted style={{ writingDirection: firstStrongDirection(t("kb.clip.privacy")) }}>
          {t("kb.clip.privacy")}
        </T>
      ) : null}
    </Screen>
  );
}
