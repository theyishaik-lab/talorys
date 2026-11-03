import { useFocusEffect } from "expo-router";
import { RotateCcw, Save, Search, Trash2 } from "lucide-react-native";
import { useCallback, useState } from "react";
import { Alert, StyleSheet, TextInput, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, Row } from "../../components/SettingsList";
import { Button, Icon, IconButton, T, useFont } from "../../components/ui";
import { type ScreenWords, TalorysKeyboard } from "../../../modules/talorys-keyboard";
import { useI18n } from "../../lib/i18n";
import { parseExcludedApps } from "../../lib/keyboardSettings";
import { radii, useTheme } from "../../lib/theme";

const MAX_ROWS = 300;

/**
 * Settings → Keyboard → Words from the screen: the words learned from what apps showed (search,
 * delete one, clear all) and the apps screen learning never reads.
 */
export default function KeyboardWordsScreen() {
  const { c } = useTheme();
  const { t, rtl } = useI18n();
  const font = useFont();
  const native = TalorysKeyboard;
  const [query, setQuery] = useState("");
  const [data, setData] = useState<ScreenWords>({ words: [], total: 0, matching: 0, pending: 0 });
  const [excluded, setExcluded] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!native) return;
    setData(native.getScreenWords(query));
  }, [native, query]);
  useFocusEffect(load);
  useFocusEffect(
    useCallback(() => {
      if (native) setExcluded(native.getExcludedApps().join("\n"));
    }, [native]),
  );

  if (!native) {
    return (
      <Screen title={t("kb.screen.manage")}>
        <T muted>{t("kb.unavailable")}</T>
      </Screen>
    );
  }

  const input = { fontFamily: font, fontSize: 15, color: c.fg, textAlign: (rtl ? "right" : "left") as "right" | "left" };

  const saveExcluded = () => {
    const saved = native.setExcludedApps(parseExcludedApps(excluded));
    setExcluded(saved.join("\n"));
    setNote(t("kb.excluded.saved", { n: saved.length }));
  };
  const resetExcluded = () => {
    const saved = native.setExcludedApps(null);
    setExcluded(saved.join("\n"));
    setNote(t("kb.excluded.saved", { n: saved.length }));
  };
  const clearAll = () =>
    Alert.alert(t("kb.screen.clear"), t("kb.screen.clearConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("kb.screen.clear"),
        style: "destructive",
        onPress: () => {
          native.clearScreenWords();
          load();
        },
      },
    ]);

  return (
    <Screen title={t("kb.screen.manage")}>
      <T size={13} muted>
        {t("kb.screen.privacy")}
      </T>

      <Group title={t("kb.screen.words")} footer={t("kb.screen.count", { n: data.total, pending: data.pending })}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border }}>
          <Icon icon={Search} size={18} color={c.fgMuted} />
          <TextInput value={query} onChangeText={setQuery} placeholder={t("kb.screen.search")} placeholderTextColor={c.fgFaint} autoCapitalize="none" autoCorrect={false} style={[input, { flex: 1, paddingVertical: 12 }]} />
        </View>
        {data.words.length === 0 ? (
          <Row title={t("kb.screen.empty")} last />
        ) : (
          data.words.slice(0, MAX_ROWS).map((w, i, arr) => (
            <Row
              key={`${w.lang}:${w.word}`}
              title={w.word}
              subtitle={t("kb.screen.seen", { n: w.count })}
              last={i === arr.length - 1}
              right={
                <IconButton
                  icon={Trash2}
                  label={t("kb.screen.delete", { word: w.word })}
                  onPress={() => {
                    native.deleteScreenWord(w.lang, w.word);
                    load();
                  }}
                />
              }
            />
          ))
        )}
      </Group>
      {data.matching > MAX_ROWS ? (
        <T size={12} muted>
          {t("kb.screen.more", { n: data.matching - MAX_ROWS })}
        </T>
      ) : null}
      {data.total ? <Button title={t("kb.screen.clear")} variant="danger" icon={Trash2} onPress={clearAll} /> : null}

      <Group title={t("kb.excluded")} footer={t("kb.excluded.hint")}>
        <TextInput
          value={excluded}
          onChangeText={setExcluded}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="com.example.bank"
          placeholderTextColor={c.fgFaint}
          style={[input, { minHeight: 140, maxHeight: 280, padding: 14, textAlign: "left", writingDirection: "ltr", fontSize: 13, textAlignVertical: "top", borderRadius: radii.md }]}
        />
      </Group>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <Button title={t("kb.excluded.save")} icon={Save} small onPress={saveExcluded} />
        <Button title={t("kb.excluded.reset")} icon={RotateCcw} small variant="secondary" onPress={resetExcluded} />
      </View>
      {note ? (
        <T size={13} color={c.success}>
          {note}
        </T>
      ) : null}
    </Screen>
  );
}
