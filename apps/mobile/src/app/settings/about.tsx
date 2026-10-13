import Constants from "expo-constants";
import { Code } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Linking } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, Row } from "../../components/SettingsList";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useI18n } from "../../lib/i18n";

interface SystemInfo {
  version?: string;
  deployed_version?: string;
  model?: string;
}

export default function AboutScreen() {
  const { t } = useI18n();
  const auth = useAuth();
  const [info, setInfo] = useState<SystemInfo>({});
  useEffect(() => {
    api<SystemInfo>("/system").then(setInfo).catch(() => {});
  }, []);
  return (
    <Screen title={t("m.about")}>
      <Group>
        <Row title={t("m.about.app")} value={`${Constants.expoConfig?.version} (${Constants.expoConfig?.android?.versionCode ?? ""})`} />
        <Row title={t("m.about.agent")} value={info.deployed_version ?? info.version ?? "—"} />
        <Row title={t("m.about.model")} value={info.model?.split("/").pop() ?? "—"} />
        <Row title={t("m.about.server")} value={auth.server.replace(/^https?:\/\//, "")} last />
      </Group>
      <Group>
        <Row icon={Code} title={t("m.source")} value="theyishaik-lab/talorys" chevron last onPress={() => Linking.openURL("https://github.com/theyishaik-lab/talorys").catch(() => {})} />
      </Group>
    </Screen>
  );
}
