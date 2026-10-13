import { type ComponentType, type ReactNode, useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PushKind, PushPrefs, PushSubscriptionView } from "@talorys/shared";
import { BellRing, Download, Smartphone } from "lucide-react";
import { Button, Switch } from "./ui";
import { useToast, errorMessage } from "../hooks/toast";
import { useT } from "../lib/i18n";
import { canPromptInstall, isIOS, isStandalone, onInstallAvailable, promptInstall } from "../lib/pwa";
import { currentSubscription, disablePush, enablePush, lookupDevice, permissionState, pushConfig, pushSupport, sendTestPush, setDevicePrefs } from "../lib/push";

/**
 * Settings → "Device notifications": install the app, turn Web Push on for this device, choose
 * what it gets, send a test. The state lives in the browser (its subscription) and in the agent
 * (this device's row), so everything here reads both before it shows a switch.
 */

const KINDS: PushKind[] = ["approval", "result", "reminder"];

function useInstallState() {
  const [, bump] = useState(0);
  useEffect(() => onInstallAvailable(() => bump((n) => n + 1)), []);
  return { standalone: isStandalone(), ios: isIOS(), promptable: canPromptInstall() };
}

export interface SettingsParts {
  Section: ComponentType<{ title?: string; children: ReactNode }>;
  Row: ComponentType<{ label: string; hint?: ReactNode; children: ReactNode }>;
}

/** The section as the redesigned Settings screen renders it, with its own group/row primitives. */
export function DeviceNotificationsSection({ Section, Row }: SettingsParts) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const install = useInstallState();
  const support = pushSupport(install);
  const config = useQuery({ queryKey: ["push", "config"], queryFn: pushConfig, staleTime: 60_000 });
  const [permission, setPermission] = useState(permissionState());
  const [device, setDevice] = useState<PushSubscriptionView | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setPermission(permissionState());
    if (support !== "ok") return setDevice(null);
    try {
      const sub = await currentSubscription();
      setDevice(sub ? await lookupDevice(sub) : null);
    } catch {
      setDevice(null);
    }
  }, [support]);
  useEffect(() => void refresh(), [refresh]);

  const enabled = !!device && permission === "granted";
  const configured = config.data?.enabled ?? true;

  const toggle = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (on) {
        const key = config.data?.public_key;
        if (!key) throw new Error(t("push.notConfigured"));
        const r = await enablePush(key);
        setPermission(r.permission);
        setDevice(r.device);
        if (r.device) toast(t("push.enabledToast"));
        else if (r.permission === "denied") toast(t("push.denied"), "error");
      } else {
        await disablePush(device?.id ?? null);
        setDevice(null);
        toast(t("push.disabledToast"));
      }
      void qc.invalidateQueries({ queryKey: ["push", "config"] });
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const setKind = async (kind: PushKind, on: boolean) => {
    if (!device) return;
    const before = device;
    setDevice({ ...device, prefs: { ...device.prefs, [kind]: on } as PushPrefs });
    try {
      setDevice(await setDevicePrefs(device.id, { [kind]: on }));
    } catch (error) {
      setDevice(before);
      toast(errorMessage(error), "error");
    }
  };

  const test = async () => {
    if (!device) return;
    setBusy(true);
    try {
      const results = await sendTestPush(device.id);
      const mine = results.find((r) => r.id === device.id);
      if (mine?.ok) toast(t("push.testSent"));
      else {
        toast(t("push.testFailed", { status: String(mine?.status ?? "?") }), "error");
        if (mine?.gone) setDevice(null);
      }
    } catch (error) {
      toast(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const enableHint = !configured
    ? t("push.notConfigured")
    : support === "ios-not-installed"
      ? t("push.iosNotInstalled")
      : support !== "ok"
        ? t("push.unsupported")
        : permission === "denied"
          ? t("push.denied")
          : t("push.enableHint");
  const canEnable = configured && support === "ok" && permission !== "denied";

  return (
    <div data-testid="device-notifications">
      <Section title={t("settings.deviceNotifications")}>
          <Row
            label={t("push.install")}
            hint={install.standalone ? t("push.installed") : install.ios ? t("push.installIos") : install.promptable ? t("push.installHint") : t("push.installBrowserMenu")}
          >
            {install.standalone ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted">
                <Smartphone className="h-4 w-4" aria-hidden /> {t("push.installed")}
              </span>
            ) : install.promptable ? (
              <Button variant="outline" size="sm" onClick={() => void promptInstall()}>
                <Download className="h-4 w-4" aria-hidden /> {t("push.installButton")}
              </Button>
            ) : (
              <span />
            )}
          </Row>
          <Row label={t("push.enable")} hint={enableHint}>
            <Switch checked={enabled} onChange={(v) => void toggle(v)} label={t("push.enable")} disabled={busy || !canEnable || device === undefined} />
          </Row>
          {KINDS.map((kind) => (
            <Row key={kind} label={t(`push.kind.${kind}`)} hint={t(`push.kind.${kind}Hint`)}>
              <Switch checked={enabled && device.prefs[kind]} onChange={(v) => void setKind(kind, v)} label={t(`push.kind.${kind}`)} disabled={!enabled || busy} />
            </Row>
          ))}
          <Row label={t("push.test")} hint={config.data ? t("push.devices", { n: String(config.data.subscriptions) }) : undefined}>
            <Button variant="outline" size="sm" onClick={() => void test()} disabled={!enabled || busy} loading={busy && enabled}>
              <BellRing className="h-4 w-4" aria-hidden /> {t("push.test")}
            </Button>
          </Row>
        </div>
      </Card>
    </section>
  );
}
