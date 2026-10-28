import type { Automation, ScheduleSpec } from "@talorys/shared";
import { memo, useCallback } from "react";
import { Trash2 } from "lucide-react-native";
import { Alert, Switch, View } from "react-native";
import { ListScreen } from "../components/ListScreen";
import { Card, Chip, IconButton, T } from "../components/ui";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useTheme } from "../lib/theme";

const DAYS = ["m.auto.day.0", "m.auto.day.1", "m.auto.day.2", "m.auto.day.3", "m.auto.day.4", "m.auto.day.5", "m.auto.day.6"] as const;

/** The schedule in the UI language (the server's schedule_description is English only); same words as the web. */
function describeSchedule(spec: ScheduleSpec, t: ReturnType<typeof useI18n>["t"]): string {
  switch (spec.type) {
    case "once":
      return t("m.auto.desc.once", { at: spec.at.replace("T", " ") });
    case "daily":
      return t("m.auto.desc.daily", { time: spec.time });
    case "weekly":
      if (spec.days.length === 7) return t("m.auto.desc.daily", { time: spec.time });
      return t("m.auto.desc.weekly", { days: [...spec.days].sort().map((d) => t(DAYS[d] ?? "m.auto.day.0")).join(", "), time: spec.time });
    case "monthly":
      return t("m.auto.desc.monthly", { day: spec.day, time: spec.time });
    case "interval":
      if (spec.minutes % 60 === 0) return spec.minutes === 60 ? t("m.auto.desc.hoursOne") : t("m.auto.desc.hours", { n: spec.minutes / 60 });
      return t("m.auto.desc.minutes", { n: spec.minutes });
  }
}

const AutomationRow = memo(function AutomationRow({ item, reload }: { item: Automation; reload: () => void }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const toggle = async (enabled: boolean) => {
    await api(`/automations/${item.id}`, { method: "PATCH", body: { enabled } }).catch(() => {});
    reload();
  };
  const remove = () =>
    Alert.alert(t("m.deleteConfirm", { title: item.name }), undefined, [
      { text: t("common.cancel"), style: "cancel" },
      {
        text: t("common.delete"),
        style: "destructive",
        onPress: async () => {
          await api(`/automations/${item.id}`, { method: "DELETE" }).catch(() => {});
          reload();
        },
      },
    ]);
  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="medium">{item.name}</T>
          <T size={13} muted>
            {item.schedule ? describeSchedule(item.schedule, t) : item.schedule_description}
          </T>
        </View>
        <Switch value={item.enabled} onValueChange={toggle} trackColor={{ true: c.accent, false: c.borderStrong }} thumbColor={c.bg} />
        <IconButton icon={Trash2} onPress={remove} label={t("common.delete")} color={c.fgMuted} size={36} />
      </View>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Chip label={t(`m.auto.kind.${item.kind}` as "m.auto.kind.reminder")} />
        <Chip label={item.enabled ? t("m.automations.on") : t("m.automations.off")} color={item.enabled ? c.success : c.fgMuted} />
        {item.next_run && item.enabled ? <Chip label={t("m.automations.next", { when: new Date(item.next_run).toLocaleString() })} /> : null}
      </View>
      {item.last_error ? (
        <T size={12} color={c.danger}>
          {item.last_error}
        </T>
      ) : null}
    </Card>
  );
});

export default function AutomationsScreen() {
  const { t } = useI18n();
  const load = useCallback(async () => (await api<{ automations: Automation[] }>("/automations")).automations, []);
  return <ListScreen<Automation> title={t("nav.automations")} load={load} empty={t("m.automations.empty")} render={(a, reload) => <AutomationRow item={a} reload={reload} />} />;
}
