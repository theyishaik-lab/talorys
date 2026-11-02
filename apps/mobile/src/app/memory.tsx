import type { Memory } from "@talorys/shared";
import { Pin, PinOff, Trash2 } from "lucide-react-native";
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
  // Core memory (always shown to the AI) is changed only by the owner; a full core memory answers with an error.
  const togglePin = async () => {
    try {
      await api(`/memories/${memory.id}/pin`, { method: "POST", body: { pinned: !memory.pinned } });
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : "Failed");
    }
    reload();
  };
  return (
    <Card style={{ gap: 8 }}>
      <T>{memory.content}</T>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {memory.pinned ? <Chip label={t("m.memory.core")} color={c.accent} /> : null}
        <Chip label={t(`m.memory.cat.${memory.category}` as "m.memory.cat.other")} />
        {memory.status !== "active" ? <Chip label={t(`m.memory.status.${memory.status}` as "m.memory.status.historical")} color={c.warning} /> : null}
        {memory.source === "dream" ? <Chip label={t("m.memory.learned")} /> : null}
        <View style={{ flex: 1 }} />
        <Press onPress={togglePin} hitSlop={8} accessibilityLabel={memory.pinned ? t("m.memory.unpin") : t("m.memory.pin")}>
          <Icon icon={memory.pinned ? PinOff : Pin} size={16} color={memory.pinned ? c.accent : c.fgFaint} />
        </Press>
        <Press onPress={remove} hitSlop={8} accessibilityLabel={t("common.delete")}>
          <Icon icon={Trash2} size={16} color={c.fgFaint} />
        </Press>
      </View>
    </Card>
  );
});

export default function MemoryScreen() {
  const { t } = useI18n();
  const load = useCallback(async () => {
    const { memories } = await api<{ memories: Memory[] }>("/memories?status=active");
    // Core memory first, then the rest in the server's order.
    return [...memories.filter((m) => m.pinned), ...memories.filter((m) => !m.pinned)];
  }, []);
  return <ListScreen<Memory> title={t("nav.memory")} load={load} empty={t("m.memory.empty")} render={(m, reload) => <MemoryRow memory={m} reload={reload} />} />;
}
