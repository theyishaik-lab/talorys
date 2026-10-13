import type { ConnectCard as ConnectCardData, PendingAction, ToolActivity } from "@talorys/shared";
import * as Haptics from "expo-haptics";
import { CheckCircle2, ExternalLink, KeyRound, ShieldAlert, XCircle } from "lucide-react-native";
import { memo, useEffect, useRef, useState } from "react";
import { Linking, TextInput, View } from "react-native";
import { api } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { radii, useTheme } from "../lib/theme";
import { Button, Card, Icon, T, useFont } from "./ui";

interface Props {
  tool: ToolActivity;
  /** Called with the tool as the agent returns it after Approve / Decline. */
  onChange: (tool: ToolActivity) => void;
}

function statusLine(status: PendingAction["status"], t: ReturnType<typeof useI18n>["t"]): { text: string; icon: typeof CheckCircle2; kind: "ok" | "muted" | "bad" } {
  switch (status) {
    case "approved":
      return { text: t("chat.approved"), icon: CheckCircle2, kind: "ok" };
    case "cancelled":
      return { text: t("chat.declined"), icon: XCircle, kind: "muted" };
    case "expired":
      return { text: t("chat.expired"), icon: XCircle, kind: "muted" };
    case "failed":
      return { text: t("chat.approvalFailed"), icon: ShieldAlert, kind: "bad" };
    default:
      return { text: t("chat.awaiting"), icon: ShieldAlert, kind: "muted" };
  }
}

/** Verb-first approval card: what will happen, then Approve / Decline. Nothing runs without the tap. */
export const ApprovalCard = memo(function ApprovalCard({ tool, onChange }: Props) {
  const { c } = useTheme();
  const { t } = useI18n();
  const approval = tool.approval!;
  const [busy, setBusy] = useState<"approve" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (approval.card?.kind === "connect") return <ConnectCard tool={tool} onChange={onChange} />;

  const decide = async (kind: "approve" | "decline") => {
    setBusy(kind);
    setError(null);
    try {
      const { action } = await api<{ action: PendingAction }>(`/actions/${approval.id}/${kind === "approve" ? "approve" : "cancel"}`, { method: "POST", body: {} });
      Haptics.notificationAsync(kind === "approve" ? Haptics.NotificationFeedbackType.Success : Haptics.NotificationFeedbackType.Warning).catch(() => {});
      onChange({ ...tool, approval: action });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("m.error.generic"));
    } finally {
      setBusy(null);
    }
  };

  if (approval.status !== "pending") {
    const s = statusLine(approval.status, t);
    const color = s.kind === "ok" ? c.success : s.kind === "bad" ? c.danger : c.fgMuted;
    return (
      <Card style={{ gap: 6 }}>
        <T weight="medium">{approval.summary}</T>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon icon={s.icon} size={16} color={color} />
          <T size={13} color={color}>
            {s.text}
          </T>
        </View>
        {approval.error ? (
          <T size={13} color={c.danger}>
            {approval.error}
          </T>
        ) : null}
      </Card>
    );
  }

  return (
    <Card accent style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon icon={ShieldAlert} size={16} color={c.accentText} />
        <T size={13} weight="medium" color={c.accentText}>
          {t("chat.approvalNeeded")}
        </T>
      </View>
      <T weight="medium" size={16}>
        {approval.summary}
      </T>
      <T size={13} muted>
        {t("chat.approvalHint")}
      </T>
      {error ? (
        <T size={13} color={c.danger}>
          {t("m.chat.approveFailed", { error })}
        </T>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8, marginTop: 2 }}>
        <Button title={t("chat.approve")} onPress={() => decide("approve")} loading={busy === "approve"} disabled={busy !== null} style={{ flex: 1 }} />
        <Button title={t("chat.decline")} variant="secondary" onPress={() => decide("decline")} loading={busy === "decline"} disabled={busy !== null} style={{ flex: 1 }} />
      </View>
    </Card>
  );
});

/** Connect card: OAuth (approve → open the consent link, poll) or API key (secure fields, sent once on approve). */
function ConnectCard({ tool, onChange }: Props) {
  const { c } = useTheme();
  const { t } = useI18n();
  const font = useFont();
  const approval = tool.approval!;
  const card = approval.card as ConnectCardData;
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(!!card.account);
  const [link, setLink] = useState<string | null>(card.authorization_url ?? null);
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (polling.current) clearInterval(polling.current);
    };
  }, []);

  const startPolling = () => {
    if (polling.current) return;
    polling.current = setInterval(async () => {
      try {
        const s = await api<{ connected: boolean; account?: string }>(`/connections/${card.service}`);
        if (s.connected) {
          setConnected(true);
          if (polling.current) clearInterval(polling.current);
          polling.current = null;
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
  };

  const approve = async () => {
    setBusy(true);
    setError(null);
    try {
      const missing = (card.fields ?? []).filter((f) => f.required !== false && !values[f.key]?.trim());
      if (card.method === "api_key" && missing.length) throw new Error(missing.map((f) => f.label).join(", "));
      const { action } = await api<{ action: PendingAction }>(`/actions/${approval.id}/approve`, { method: "POST", body: card.method === "api_key" ? { values } : {} });
      setValues({});
      onChange({ ...tool, approval: action });
      const url = action.card?.authorization_url;
      if (card.method === "oauth" && url) {
        setLink(url);
        await Linking.openURL(url);
        startPolling();
      } else if (action.card?.account || action.status === "approved") {
        setConnected(true);
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : t("m.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  const decline = async () => {
    setBusy(true);
    try {
      const { action } = await api<{ action: PendingAction }>(`/actions/${approval.id}/cancel`, { method: "POST", body: {} });
      onChange({ ...tool, approval: action });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("m.error.generic"));
    } finally {
      setBusy(false);
    }
  };

  const reopen = async () => {
    try {
      const { url } = await api<{ url: string }>(`/actions/${approval.id}/link`, { method: "POST", body: {} });
      setLink(url);
      await Linking.openURL(url);
      startPolling();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("m.error.generic"));
    }
  };

  const pending = approval.status === "pending";
  const done = connected || !!card.account;

  return (
    <Card accent={pending} style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Icon icon={card.method === "api_key" ? KeyRound : ExternalLink} size={16} color={c.accentText} />
        <T size={13} weight="medium" color={c.accentText}>
          {t("chat.approvalNeeded")}
        </T>
      </View>
      <T weight="medium" size={16}>
        {approval.summary || card.name}
      </T>
      {pending && card.method === "api_key"
        ? (card.fields ?? []).map((f) => (
            <View key={f.key} style={{ gap: 4 }}>
              <T size={13} muted>
                {f.label}
              </T>
              <TextInput
                value={values[f.key] ?? ""}
                onChangeText={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
                placeholder={f.placeholder}
                placeholderTextColor={c.fgFaint}
                secureTextEntry={f.secret !== false}
                autoCapitalize="none"
                autoCorrect={false}
                textContentType="password"
                style={{ fontFamily: font, fontSize: 15, color: c.fg, backgroundColor: c.bg, borderRadius: radii.sm, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: c.border }}
              />
              {f.hint ? (
                <T size={12} muted>
                  {f.hint}
                </T>
              ) : null}
            </View>
          ))
        : null}
      {pending && card.method === "api_key" ? (
        <T size={12} muted>
          {t("m.connect.keyHint")}
        </T>
      ) : null}
      {done ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon icon={CheckCircle2} size={16} color={c.success} />
          <T size={13} color={c.success}>
            {t("m.connect.connected")}
            {card.account ? ` · ${card.account}` : ""}
          </T>
        </View>
      ) : null}
      {!pending && !done && approval.status !== "approved" ? (
        <T size={13} muted>
          {statusLine(approval.status, t).text}
        </T>
      ) : null}
      {error ? (
        <T size={13} color={c.danger}>
          {error}
        </T>
      ) : null}
      {pending ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button title={card.method === "api_key" ? t("m.connect.connect") : t("chat.approve")} onPress={approve} loading={busy} style={{ flex: 1 }} />
          <Button title={t("chat.decline")} variant="secondary" onPress={decline} disabled={busy} style={{ flex: 1 }} />
        </View>
      ) : null}
      {!pending && !done && approval.status === "approved" && card.method === "oauth" ? (
        <View style={{ gap: 6 }}>
          <T size={13} muted>
            {t("m.connect.waiting")}
          </T>
          <Button title={t("m.connect.open")} variant="secondary" icon={ExternalLink} small onPress={
              link
                ? () => {
                    Linking.openURL(link).catch(() => {});
                    startPolling();
                  }
                : reopen
            } />
        </View>
      ) : null}
    </Card>
  );
}
