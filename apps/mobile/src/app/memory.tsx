import type { Memory } from "@talorys/shared";
import { Trash2 } from "lucide-react-native";
import { memo, useCallback } from "react";
import { Alert, View } from "react-native";
import { ListScreen } from "../components/ListScreen";
import { Card, Chip, Icon, Press, T } from "../components/ui";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useTheme } from "../lib/theme";

const MemoryRow = memo(function MemoryRow({ memory, reload }: { memory: Memory; reload: () => void }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const remove = () =>
    Alert.alert(t("m.deleteConfirm", { title: memory.content.slice(0, 40) }), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: async () => {
          await api(`/memories/${memory.id}`, { method: "DELETE" }).catch(() => {});
          reload();
        },
      },
    ]);
  return (
    <Card style={{ gap: 8 }}>
      <T>{memory.content}</T>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Chip label={t(`m.memory.cat.${memory.category}` as "m.memory.cat.other")} />
        {memory.status !== "active" ? <Chip label={t(`m.memory.status.${memory.status}` as "m.memory.status.historical")} color={c.warning} /> : null}
        <View style={{ flex: 1 }} />
        <Press onPress={remove} hitSlop={8} accessibilityLabel={t("common.delete")}>
          <Icon icon={Trash2} size={16} color={c.fgFaint} />
        </Press>
      </View>
    </Card>
  );
});

export default function MemoryScreen() {
  const { t } = useI18n();
  const load = useCallback(async () => (await api<{ memories: Memory[] }>("/memories?status=active")).memories, []);
  return <ListScreen<Memory> title={t("nav.memory")} load={load} empty={t("m.memory.empty")} render={(m, reload) => <MemoryRow memory={m} reload={reload} />} />;
}
