import { CalendarDays, FolderOpen, ListTodo, Mail } from "lucide-react-native";
import { memo } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { radii, useTheme } from "../lib/theme";
import { Icon, Press, T } from "./ui";

/** Home / empty state from the mockups: greeting, then suggestion tiles that send a prompt. */
export const HomeEmpty = memo(function HomeEmpty({ agentName, onPick }: { agentName: string; onPick: (text: string) => void }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const hour = new Date().getHours();
  const greeting = hour < 5 ? t("m.goodNight") : hour < 12 ? t("chat.goodMorning") : hour < 18 ? t("chat.goodAfternoon") : t("chat.goodEvening");
  const tiles = [
    { icon: Mail, title: t("home.tile1.title"), sub: t("home.tile1.sub"), prompt: t("home.tile1.prompt") },
    { icon: CalendarDays, title: t("home.tile2.title"), sub: t("home.tile2.sub"), prompt: t("home.tile2.prompt") },
    { icon: ListTodo, title: t("home.tile3.title"), sub: t("home.tile3.sub"), prompt: t("home.tile3.prompt") },
    { icon: FolderOpen, title: t("home.tile4.title"), sub: t("home.tile4.sub"), prompt: t("home.tile4.prompt") },
  ];
  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "flex-end", padding: 16, gap: 16 }} keyboardShouldPersistTaps="handled">
      <View style={{ gap: 4, marginBottom: 8 }}>
        <T weight="semibold" size={28} style={{ lineHeight: 36 }}>
          {greeting}
        </T>
        <T size={17} muted>
          {t("chat.prompt")}
        </T>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
        {tiles.map((tile) => (
          <Press key={tile.title} onPress={() => onPick(tile.prompt)} haptic style={{ width: "48%", flexGrow: 1, backgroundColor: c.surface, borderRadius: radii.lg, padding: 14, gap: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border }}>
            <Icon icon={tile.icon} size={20} color={c.accentText} />
            <View>
              <T weight="medium" size={14}>
                {tile.title}
              </T>
              <T size={12} muted>
                {tile.sub}
              </T>
            </View>
          </Press>
        ))}
      </View>
      <T size={12} muted center style={{ marginTop: 4 }}>
        {t("chat.footer", { name: agentName })}
      </T>
    </ScrollView>
  );
});
