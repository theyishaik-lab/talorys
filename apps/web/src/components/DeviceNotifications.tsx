import { type ComponentType, type ReactNode, useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PushKind, PushPrefs, PushSubscriptionView } from "@talorys/shared";
import { AlertCircle, BellRing, Download, RotateCcw, Smartphone } from "lucide-react";
import { Button, Switch } from "./ui";
import { useToast, errorMessage } from "../hooks/toast";
import { useT } from "../lib/i18n";
import { canPromptInstall, isIOS, isStandalone, onInstallAvailable, promptInstall } from "../lib/pwa";
import { currentSubscription, disablePush, enablePush, isAndroidWebView, type LastTest, lookupDevice, permissionState, PushEnableError, pushConfig, pushSupport, readLastTest, sendTestPush, setDevicePrefs, writeLastTest } from "../lib/push";
import { relativeTime } from "../lib/utils";

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
  /** The last thing that went wrong, in the owner's words, with what to do; cleared on success. */
  const [problem, setProblem] = useState<string | null>(null);
  const [lastTest, setLastTest] = useState<LastTest | null>(readLastTest);
  const webview = isAndroidWebView();

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

  /** The sentence for a failed enable: which step, and what the owner can do about it on this device. */
  const explain = (error: unknown): string => {
    if (error instanceof PushEnableError) {
      if (error.step === "permission") {
        if (error.permission === "denied") return install.ios ? t("push.err.deniedIos") : t("push.err.deniedAndroid");
        return t("push.err.dismissed");
      }
      if (error.step === "service-worker") return t("push.err.swMissing");
      if (error.step === "subscribe") return t("push.err.subscribe", { error: error.message.slice(0, 120) });
      return t("push.err.server", { error: error.message.slice(0, 160) });
    }
    return errorMessage(error);
  };

  const toggle = async (on: boolean) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      if (on) {
        const key = config.data?.public_key;
        if (!key) throw new Error(t("push.notConfigured"));
        const r = await enablePush(key);
        setPermission(r.permission);
        setDevice(r.device);
        toast(t("push.enabledToast"));
      } else {
        await disablePush(device?.id ?? null);
        setDevice(null);
        toast(t("push.disabledToast"));
      }
      void qc.invalidateQueries({ queryKey: ["push", "config"] });
    } catch (error) {
      setPermission(permissionState());
      const text = explain(error);
      setProblem(text);
      toast(text, "error");
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
    setProblem(null);
    try {
      const results = await sendTestPush(device.id);
      const mine = results.find((r) => r.id === device.id);
      const result: LastTest = { at: new Date().toISOString(), ok: !!mine?.ok, status: mine?.status ?? 0 };
      writeLastTest(result);
      setLastTest(result);
      if (mine?.ok) toast(document.visibilityState === "visible" && document.hasFocus() ? t("push.testQuiet") : t("push.testOk", { status: String(mine.status) }));
      else {
        const text = t("push.testFailed", { status: String(mine?.status ?? "?") });
        setProblem(text);
        toast(text, "error");
        if (mine?.gone) setDevice(null);
      }
    } catch (error) {
      const text = errorMessage(error);
      setProblem(text);
      toast(text, "error");
    } finally {
      setBusy(false);
    }
  };

  const enableHint = !configured
    ? t("push.notConfigured")
    : webview
      ? t("push.err.webview")
      : support === "ios-not-installed"
        ? t("push.iosNotInstalled")
        : support !== "ok"
          ? t("push.unsupported")
          : permission === "denied"
            ? install.ios
              ? t("push.err.deniedIos")
              : t("push.err.deniedAndroid")
            : t("push.enableHint");
  // A blocked permission still gets a tappable switch: the retry re-reads the permission after the owner changed it in Android settings.
  const canEnable = configured && support === "ok" && !webview;
  const context = webview ? "webview" : install.standalone ? "standalone" : "browser";
  const permissionLabel = t(`push.state.permission.${permission}` as Parameters<typeof t>[0]);

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
          {problem && (
            <div role="alert" className="mx-4 mb-3 flex flex-wrap items-start gap-2 rounded-xl border border-danger/25 bg-danger-soft px-3 py-2.5 text-[13px] leading-5 text-danger" data-testid="push-problem">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1" dir="auto">
                {problem}
              </span>
              <Button variant="outline" size="sm" onClick={() => void toggle(true)} disabled={busy || !canEnable}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden /> {t("push.retry")}
              </Button>
            </div>
          )}
          <Row label={t("push.state.title")} hint={undefined}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12.5px] text-fg-muted sm:text-end" data-testid="push-state">
              <dt>{t("push.state.context")}</dt>
              <dd>{t(`push.state.context.${context}` as Parameters<typeof t>[0])}</dd>
              <dt>{t("push.state.permission")}</dt>
              <dd className={permission === "denied" ? "text-danger" : permission === "granted" ? "text-success" : undefined}>{permissionLabel}</dd>
              <dt>{t("push.state.registered")}</dt>
              <dd className={device ? "text-success" : undefined}>{device ? t("push.state.yes") : t("push.state.no")}</dd>
              <dt>{t("push.state.lastTest")}</dt>
              <dd className={lastTest ? (lastTest.ok ? "text-success" : "text-danger") : undefined}>
                {lastTest ? t(lastTest.ok ? "push.state.lastTestOk" : "push.state.lastTestFail", { status: String(lastTest.status), when: relativeTime(lastTest.at) }) : t("push.state.lastTestNone")}
              </dd>
            </dl>
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
      </Section>
    </div>
  );
}
