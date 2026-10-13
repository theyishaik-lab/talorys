import { Bell, BellRing, Send } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Linking, View } from "react-native";
import { Screen } from "../../components/Screen";
import { Group, Row, ToggleRow } from "../../components/SettingsList";
import { Button, T } from "../../components/ui";
import { useI18n } from "../../lib/i18n";
import { type NativePushConfig, type PermissionState, type PushDeviceView, permissionState, pushConfig, registerForPush, sendTest, storedDeviceId, unregisterPush, updatePrefs } from "../../lib/push";
import { useTheme } from "../../lib/theme";

export default function NotificationsScreen() {
  const { c } = useTheme();
  const { t } = useI18n();
  const [perm, setPerm] = useState<PermissionState>("undetermined");
  const [config, setConfig] = useState<NativePushConfig | null | "unsupported">(null);
  const [device, setDevice] = useState<PushDeviceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    setPerm(await permissionState());
    const cfg = await pushConfig().catch(() => null);
    if (!cfg) {
      setConfig("unsupported");
      return;
    }
    setConfig(cfg);
    const id = await storedDeviceId();
    setDevice(cfg.devices.find((d) => d.id === id) ?? null);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const enable = async (on: boolean) => {
    setBusy(true);
    setNote(null);
    try {
      if (on) {
        const r = await registerForPush({ ask: true });
        setPerm(r.state);
        if (r.state === "denied") setNote(t("m.notifications.permissionDenied"));
        else if (r.reason === "agent-no-native-push") setNote(t("m.notifications.notConfigured"));
        else if (r.reason) setNote(r.reason);
        setDevice(r.device);
      } else {
        await unregisterPush();
        setDevice(null);
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (kind: keyof PushDeviceView["prefs"], value: boolean) => {
    if (!device) return;
    const next = { ...device, prefs: { ...device.prefs, [kind]: value } };
    setDevice(next);
    try {
      setDevice(await updatePrefs(device.id, { [kind]: value }));
    } catch {
      setDevice(device);
    }
  };

  const test = async () => {
    if (!device) return;
    setBusy(true);
    setNote(null);
    try {
      const r = await sendTest(device.id);
      const bad = r.results.find((x) => x.error || (typeof x.status === "number" && x.status >= 300));
      setNote(bad ? t("m.notifications.testFailed", { error: bad.error ?? String(bad.status) }) : t("m.notifications.testSent"));
    } catch (e) {
      setNote(t("m.notifications.testFailed", { error: e instanceof Error ? e.message : "?" }));
    } finally {
      setBusy(false);
    }
  };

  const enabled = !!device && perm === "granted";

  return (
    <Screen title={t("m.notifications")}>
      {config === null ? (
        <ActivityIndicator color={c.accent} />
      ) : (
        <>
          <Group footer={config === "unsupported" ? t("m.notifications.notConfigured") : perm === "denied" ? t("m.notifications.permissionDenied") : enabled ? t("m.notifications.registered") : t("push.enableHint")}>
            <ToggleRow title={t("m.notifications.enable")} value={enabled} onChange={enable} disabled={busy || config === "unsupported"} last />
          </Group>
          {perm === "denied" ? <Button title={t("settings.title")} variant="secondary" small icon={Bell} onPress={() => Linking.openSettings()} /> : null}
          {enabled && device ? (
            <>
              <Group title={t("nav.notifications")}>
                <ToggleRow title={t("push.kind.approval")} subtitle={t("push.kind.approvalHint")} value={device.prefs.approval} onChange={(v) => toggle("approval", v)} />
                <ToggleRow title={t("push.kind.result")} subtitle={t("push.kind.resultHint")} value={device.prefs.result} onChange={(v) => toggle("result", v)} />
                <ToggleRow title={t("push.kind.reminder")} subtitle={t("push.kind.reminderHint")} value={device.prefs.reminder} onChange={(v) => toggle("reminder", v)} last />
              </Group>
              <Button title={t("push.test")} icon={Send} variant="secondary" onPress={test} loading={busy} />
            </>
          ) : null}
          {config !== "unsupported" && config.devices.length ? (
            <Group title={t("push.devices", { n: config.devices.length })}>
              {config.devices.map((d, i) => (
                <Row key={d.id} icon={BellRing} title={d.label || d.platform} subtitle={d.id === device?.id ? t("m.account.thisDevice") : d.last_used_at ? new Date(d.last_used_at).toLocaleString() : undefined} last={i === config.devices.length - 1} />
              ))}
            </Group>
          ) : null}
          {note ? (
            <View>
              <T size={13} color={note.includes("—") ? c.success : c.danger}>
                {note}
              </T>
            </View>
          ) : null}
        </>
      )}
    </Screen>
  );
}
