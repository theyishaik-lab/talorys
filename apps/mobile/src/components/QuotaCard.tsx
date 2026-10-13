import { router } from "expo-router";
import { Settings2 } from "lucide-react-native";
import { View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useTheme } from "../lib/theme";
import { Button, Card, T } from "./ui";

/** Shown under the chat when the provider's allowance is spent: a plain message and the way out. */
export function QuotaCard({ message }: { message: string }) {
  const { c } = useTheme();
  const { t } = useI18n();
  return (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
      <Card style={{ gap: 8 }}>
        <T weight="medium">{t("m.chat.quotaTitle")}</T>
        <T size={13} color={c.fg2}>
          {message}
        </T>
        <Button title={t("m.chat.openSettings")} variant="secondary" icon={Settings2} small onPress={() => router.push("/settings/model")} />
      </Card>
    </View>
  );
}
