import type { Automation } from "@talorys/shared";
import { memo, useCallback } from "react";
import { Switch, View } from "react-native";
import { ListScreen } from "../components/ListScreen";
import { Card, Chip, T } from "../components/ui";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useTheme } from "../lib/theme";

const AutomationRow = memo(function AutomationRow({ item, reload }: { item: Automation; reload: () => void }) {
  const { c } = useTheme();
  const { t } = useI18n();
  const toggle = async (enabled: boolean) => {
    await api(`/automations/${item.id}`, { method: "PATCH", body: { enabled } }).catch(() => {});
    reload();
  };
  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <View style={{ flex: 1, gap: 2 }}>
          <T weight="medium">{item.name}</T>
          <T size={13} muted>
            {item.schedule_description}
          </T>
        </View>
        <Switch value={item.enabled} onValueChange={toggle} trackColor={{ true: c.accent, false: c.borderStrong }} thumbColor={c.bg} />
      </View>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Chip label={item.kind} />
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
