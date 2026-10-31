import Constants from "expo-constants";
import { router } from "expo-router";
import { Bell, Cpu, Info, Keyboard, Languages, Link2, UserRound } from "lucide-react-native";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, RadioRow, Row } from "../../components/SettingsList";
import { T } from "../../components/ui";
import { isKeyboardAvailable } from "../../../modules/talorys-keyboard";
import { api } from "../../lib/api";
import { LOCALE_NAMES, type LocalePreference, deviceLocale, useI18n } from "../../lib/i18n";
import { type ThemeMode, useTheme } from "../../lib/theme";

export default function SettingsScreen() {
  const theme = useTheme();
  const { t, pref, setPreference } = useI18n();
  const [model, setModel] = useState<string>("");
  const [restart, setRestart] = useState(false);

  useEffect(() => {
    api<{ settings: { model?: string } }>("/settings")
      .then((r) => setModel(r.settings.model ?? ""))
      .catch(() => {});
  }, []);

  const modes: { key: ThemeMode; label: string }[] = [
    { key: "system", label: t("settings.theme.auto") },
    { key: "light", label: t("settings.theme.light") },
    { key: "dark", label: t("settings.theme.dark") },
  ];
  const langs: { key: LocalePreference; label: string }[] = [
    { key: "auto", label: t("settings.language.auto", { name: LOCALE_NAMES[deviceLocale()] }) },
    { key: "he", label: LOCALE_NAMES.he },
    { key: "en", label: LOCALE_NAMES.en },
  ];

  return (
    <Screen title={t("settings.title")}>
      <Group title={t("settings.appearance")}>
        {modes.map((m, i) => (
          <RadioRow key={m.key} title={m.label} selected={theme.mode === m.key} onPress={() => theme.setMode(m.key)} last={i === modes.length - 1} />
        ))}
      </Group>
      <Group title={t("settings.language")} footer={restart ? t("m.restartForLanguage") : t("settings.languageHint")}>
        {langs.map((l, i) => (
          <RadioRow
            key={l.key}
            title={l.label}
            selected={pref === l.key}
            onPress={() => {
              setPreference(l.key);
              setRestart(true);
            }}
            last={i === langs.length - 1}
          />
        ))}
      </Group>
      <Group>
        {isKeyboardAvailable() ? <Row icon={Keyboard} title={t("kb.title")} subtitle={t("kb.hint")} chevron onPress={() => router.push("/settings/keyboard")} /> : null}
        <Row icon={Bell} title={t("m.notifications")} subtitle={t("m.notifications.hint")} chevron onPress={() => router.push("/settings/notifications")} />
        <Row icon={Cpu} title={t("settings.model")} subtitle={t("m.model.hint")} value={model.split("/").pop()} chevron onPress={() => router.push("/settings/model")} />
        <Row icon={Link2} title={t("settings.connections")} subtitle={t("m.connections.hint")} chevron onPress={() => router.push("/settings/connections")} />
        <Row icon={UserRound} title={t("settings.account")} subtitle={t("m.account.hint")} chevron onPress={() => router.push("/settings/account")} />
        <Row icon={Info} title={t("m.about")} subtitle={t("m.about.hint")} value={Constants.expoConfig?.version} chevron last onPress={() => router.push("/settings/about")} />
      </Group>
      <View style={{ alignItems: "center", gap: 2 }}>
        <Languages size={14} color={theme.c.fgFaint} />
        <T size={12} muted>
          Talorys {Constants.expoConfig?.version}
        </T>
      </View>
    </Screen>
  );
}
