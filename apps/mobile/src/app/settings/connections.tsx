import { CheckCircle2, Circle } from "lucide-react-native";
import { useEffect, useState } from "react";
import { ActivityIndicator } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, Row } from "../../components/SettingsList";
import { T } from "../../components/ui";
import { api } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { useTheme } from "../../lib/theme";

interface Connection {
  service: string;
  name?: string;
  connected: boolean;
  account?: string | null;
}

/** Apps connected through the connector. The list route is the Settings worker's; older agents get a hint. */
export default function ConnectionsScreen() {
  const { c } = useTheme();
  const { t } = useI18n();
  const [items, setItems] = useState<Connection[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ connections: Connection[] }>("/connections")
      .then((r) => setItems(r.connections))
      .catch((e) => {
        setItems([]);
        if (!(e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404)) setError(e instanceof Error ? e.message : null);
      });
  }, []);

  return (
    <Screen title={t("settings.connections")}>
      {items === null ? (
        <ActivityIndicator color={c.accent} />
      ) : items.length === 0 ? (
        <T muted>{error ?? t("m.connections.none")}</T>
      ) : (
        <Group>
          {items.map((x, i) => (
            <Row key={x.service} icon={x.connected ? CheckCircle2 : Circle} title={x.name ?? x.service} subtitle={x.connected ? `${t("m.connections.connected")}${x.account ? ` · ${x.account}` : ""}` : t("m.connections.notConnected")} last={i === items.length - 1} />
          ))}
        </Group>
      )}
    </Screen>
  );
}
