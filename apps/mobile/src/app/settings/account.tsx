import { LogOut, Smartphone } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, Row } from "../../components/SettingsList";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../lib/i18n";

interface SessionInfo {
  id: string;
  created_at: string;
  last_seen_at: string;
  user_agent: string;
  current: boolean;
}

export default function AccountScreen() {
  const { t } = useI18n();
  const auth = useAuth();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);

  const load = () =>
    api<{ sessions: SessionInfo[] }>("/auth/sessions")
      .then((r) => setSessions(r.sessions))
      .catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const signOut = () =>
    Alert.alert(t("m.account.signOut"), t("m.account.signOutConfirm"), [
      { text: t("common.cancel"), style: "cancel" },
      { text: t("m.account.signOut"), style: "destructive", onPress: () => auth.signOut() },
    ]);

  const revokeOthers = async () => {
    await api("/auth/sessions/revoke-others", { method: "POST", body: {} }).catch(() => {});
    load();
  };

  return (
    <Screen title={t("settings.account")}>
      <Group title={t("m.about.server")}>
        <Row title={auth.server.replace(/^https?:\/\//, "")} last />
      </Group>
      {sessions.length ? (
        <Group title={t("m.account.sessions")}>
          {sessions.map((s, i) => (
            <Row key={s.id} icon={Smartphone} title={s.current ? t("m.account.thisDevice") : s.user_agent.slice(0, 40) || s.id} subtitle={new Date(s.last_seen_at).toLocaleString()} last={i === sessions.length - 1} />
          ))}
        </Group>
      ) : null}
      {sessions.length > 1 ? <Button title={t("m.account.revokeOthers")} variant="secondary" onPress={revokeOthers} /> : null}
      <Button title={t("m.account.signOut")} variant="danger" icon={LogOut} onPress={signOut} />
    </Screen>
  );
}
