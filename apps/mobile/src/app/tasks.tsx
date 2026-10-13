import type { Task } from "@talorys/shared";
import * as Haptics from "expo-haptics";
import { CheckCircle2, Circle, Trash2 } from "lucide-react-native";
import { memo, useCallback, useState } from "react";
import { Alert, View } from "react-native";
import { ListScreen } from "../components/ListScreen";
import { Card, Icon, Press, T } from "../components/ui";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useTheme } from "../lib/theme";

const TaskRow = memo(function TaskRow({ task, reload }: { task: Task; reload: () => void }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const done = task.status === "done";
  const toggle = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    await api(`/tasks/${task.id}`, { method: "PATCH", body: { status: done ? "todo" : "done" } }).catch(() => {});
    reload();
  };
  const remove = () =>
    Alert.alert(t("m.deleteConfirm", { title: task.title }), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("common.delete"), style: "destructive", onPress: async () => {
          await api(`/tasks/${task.id}`, { method: "DELETE" }).catch(() => {});
          reload();
        },
      },
    ]);
  const due = task.due_at ? new Date(task.due_at) : null;
  const overdue = due && !done && due.getTime() < Date.now();
  return (
    <Card style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <Press onPress={toggle} hitSlop={8} accessibilityLabel={done ? t("m.tasks.reopen") : t("m.tasks.markDone")}>
        <Icon icon={done ? CheckCircle2 : Circle} size={22} color={done ? c.success : c.fgMuted} />
      </Press>
      <View style={{ flex: 1, gap: 2 }}>
        <T style={{ textDecorationLine: done ? "line-through" : "none" }} color={done ? c.fgMuted : c.fg}>
          {task.title}
        </T>
        {due ? (
          <T size={12} color={overdue ? c.danger : c.fgMuted}>
            {due.toLocaleString()}
          </T>
        ) : null}
        {task.priority === "high" || task.priority === "urgent" ? (
          <T size={12} color={c.warning}>
            {task.priority}
          </T>
        ) : null}
      </View>
      <Press onPress={remove} hitSlop={8} accessibilityLabel={t("common.delete")}>
        <Icon icon={Trash2} size={18} color={c.fgFaint} />
      </Press>
    </Card>
  );
});

export default function TasksScreen() {
  const { t } = useI18n();
  const { c } = useTheme();
  const [view, setView] = useState<"open" | "done">("open");
  const load = useCallback(async () => {
    const { tasks } = await api<{ tasks: Task[] }>(`/tasks?status=${view === "open" ? "open" : "done"}`);
    return tasks;
  }, [view]);
  return (
    <ListScreen<Task>
      title={t("nav.tasks")}
      load={load}
      empty={t("m.tasks.empty")}
      header={
        <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 12 }}>
          {(["open", "done"] as const).map((v) => (
            <Press key={v} onPress={() => setView(v)} style={{ paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, backgroundColor: view === v ? c.fg : c.surface }}>
              <T size={13} weight="medium" color={view === v ? c.bg : c.fg}>
                {v === "open" ? t("m.tasks.open") : t("m.tasks.done")}
              </T>
            </Press>
          ))}
        </View>
      }
      render={(task, reload) => <TaskRow task={task} reload={reload} />}
    />
  );
}
