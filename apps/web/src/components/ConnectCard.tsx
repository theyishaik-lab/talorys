import { type ReactNode, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConnectCard as ConnectCardData, PendingAction } from "@talorys/shared";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Plug, XCircle } from "lucide-react";
import { keys, useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";
import { useLocale } from "../lib/i18n";
import { Button, Input } from "./ui";
import { cn } from "../lib/utils";

/**
 * The card for a `connect_service` proposal. Nothing is connected until the owner taps Approve:
 * an OAuth app then shows the provider's sign-in link and waits for the connection to appear; a
 * key-based app shows its secret fields here, and the typed values go only to the approve request
 * (never into the chat, the message history, or the model's context).
 */

const STRINGS = {
  en: {
    title: (name: string) => `Connect ${name}?`,
    oauthHint: "After you approve, a sign-in page opens. Nothing is connected until you finish it.",
    keyHint: "The key goes straight to the connector. It is never shown in the chat.",
    approve: "Approve",
    decline: "Decline",
    openSignIn: (name: string) => `Sign in to ${name}`,
    waiting: "Waiting for the sign-in to finish…",
    connected: (name: string, account: string | null) => `${name} connected${account ? ` as ${account}` : ""}`,
    declined: "Declined — nothing was connected",
    expired: "Expired — ask again if you still want this",
    failed: "Could not connect",
    required: "Required",
  },
  he: {
    title: (name: string) => `לחבר את ${name}?`,
    oauthHint: "אחרי האישור ייפתח מסך התחברות. שום דבר לא מתחבר עד שתסיים אותו.",
    keyHint: "המפתח נשלח ישירות למחבר ולא מוצג בצ'אט.",
    approve: "אישור",
    decline: "לא עכשיו",
    openSignIn: (name: string) => `התחברות ל-${name}`,
    waiting: "ממתין לסיום ההתחברות…",
    connected: (name: string, account: string | null) => `${name} מחובר${account ? ` (${account})` : ""}`,
    declined: "נדחה — שום דבר לא חובר",
    expired: "פג תוקף — בקש שוב אם עדיין רוצה",
    failed: "החיבור נכשל",
    required: "חובה",
  },
};

export function ConnectCard({ action: initial }: { action: PendingAction & { card: ConnectCardData } }) {
  const { locale, t: tr } = useLocale();
  const t = STRINGS[locale];
  const qc = useQueryClient();
  const [action, setAction] = useState<PendingAction>(initial);
  useEffect(() => setAction(initial), [initial]);
  const card = (action.card ?? initial.card) as ConnectCardData;
  const [values, setValues] = useState<Record<string, string>>({});
  const [account, setAccount] = useState<string | null>(card.account ?? null);
  const [link, setLink] = useState<string | undefined>(card.authorization_url);
  useEffect(() => setLink(card.authorization_url), [card.authorization_url]);

  const decide = useApiMutation(
    (decision: "approve" | "cancel") =>
      api<{ action: PendingAction }>(`/actions/${action.id}/${decision}`, {
        method: "POST",
        body: decision === "approve" && card.method === "api_key" ? { values } : {},
      }).catch((error: unknown) => {
        void qc.invalidateQueries({ queryKey: ["conversation"] });
        throw error;
      }),
    {
      invalidate: [["conversation"], keys.notifications],
      onSuccess: (r) => {
        setValues({});
        setAction(r.action);
        if (r.action.card?.account) setAccount(r.action.card.account);
      },
    },
  );

  const status = action.status === "pending" && Date.parse(action.expires_at) <= Date.now() ? "expired" : action.status;
  const awaitingSignIn = status === "approved" && card.method === "oauth" && !account;

  // The connector's sign-in link lives 15 minutes: fetch a fresh one each time the card is shown.
  useEffect(() => {
    if (!awaitingSignIn) return;
    let cancelled = false;
    api<{ url: string }>(`/actions/${action.id}/link`, { method: "POST", body: {} })
      .then((r) => {
        if (!cancelled && r.url) setLink(r.url);
      })
      .catch(() => {
        /* the stored link stays */
      });
    return () => {
      cancelled = true;
    };
  }, [awaitingSignIn, action.id]);

  // After an OAuth approval the sign-in happens in another tab; poll until the connector lists the app.
  useEffect(() => {
    if (!awaitingSignIn) return;
    let stopped = false;
    const started = Date.now();
    const tick = async () => {
      if (stopped || document.visibilityState === "hidden") return;
      try {
        const r = await api<{ connected: boolean; account: string | null }>(`/connections/${encodeURIComponent(card.service)}`);
        if (r.connected && !stopped) {
          setAccount(r.account ?? "connected");
          void qc.invalidateQueries({ queryKey: ["conversation"] });
        }
      } catch {
        /* try again on the next tick */
      }
    };
    const id = setInterval(() => {
      if (Date.now() - started > 15 * 60_000) clearInterval(id);
      else void tick();
    }, 4000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      stopped = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [awaitingSignIn, card.service, qc]);

  const fields = card.fields ?? [];
  const filled = fields.every((f) => f.required === false || (values[f.key] ?? "").trim().length > 0);

  if (status === "approved" && account) {
    return (
      <Done icon="ok">
        <span className="text-fg">{t.connected(card.name, account === "connected" ? null : account)}</span>
      </Done>
    );
  }
  if (awaitingSignIn && link) {
    return (
      <div role="group" aria-label={tr("connect.signInGroup")} className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
        <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
          <AppIcon>
            <Plug className="h-5 w-5" />
          </AppIcon>
          <div className="min-w-0 flex-1">
            <p className="break-words text-[15px] font-semibold leading-snug text-fg">{card.name}</p>
            <p className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-fg-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> {t.waiting}
            </p>
          </div>
        </div>
        <div className="px-4 pb-3.5">
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="pressable inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-[15px] font-semibold text-accent-fg hover:opacity-90"
          >
            <ExternalLink className="h-4 w-4" /> {t.openSignIn(card.name)}
          </a>
        </div>
      </div>
    );
  }
  if (status !== "pending") {
    const note = status === "cancelled" ? t.declined : status === "expired" ? t.expired : status === "failed" ? t.failed : t.waiting;
    return (
      <Done icon={status === "failed" ? "error" : "off"}>
        <span className="text-fg">{card.name}</span> · {note}
        {status === "failed" && action.error ? `: ${action.error}` : ""}
      </Done>
    );
  }
  return (
    <div role="group" aria-label={tr("connect.approvalGroup")} className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <AppIcon>{card.method === "api_key" ? <KeyRound className="h-5 w-5" /> : <Plug className="h-5 w-5" />}</AppIcon>
        <div className="min-w-0 flex-1">
          <p className="break-words text-[15px] font-semibold leading-snug text-fg">{t.title(card.name)}</p>
          <p className="mt-0.5 text-[12.5px] text-fg-muted">{card.method === "oauth" ? t.oauthHint : t.keyHint}</p>
        </div>
      </div>
      {card.method === "api_key" && fields.length > 0 && (
        <form
          className="space-y-2 px-4 pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (filled && !decide.isPending) decide.mutate("approve");
          }}
        >
          {fields.map((f) => (
            <label key={f.key} className="block text-xs text-fg-muted">
              <span className="mb-1 block">
                {f.label}
                {f.required === false ? "" : <span className="text-fg-subtle"> · {t.required}</span>}
              </span>
              <Input
                type={f.secret === false ? "text" : "password"}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                dir="ltr"
                placeholder={f.placeholder}
                value={values[f.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="h-9 font-mono text-sm"
              />
              {f.hint && <span className="mt-1 block text-[11px] leading-4 text-fg-subtle">{f.hint}</span>}
            </label>
          ))}
        </form>
      )}
      <div className="flex gap-2 px-4 pb-3.5 pt-2">
        <Button
          className="flex-1 justify-center"
          loading={decide.isPending && decide.variables === "approve"}
          disabled={decide.isPending || (card.method === "api_key" && !filled)}
          onClick={() => decide.mutate("approve")}
        >
          {t.approve}
        </Button>
        <Button variant="secondary" className="flex-1 justify-center" disabled={decide.isPending} onClick={() => decide.mutate("cancel")}>
          {t.decline}
        </Button>
      </div>
    </div>
  );
}

function AppIcon({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent-text" aria-hidden>
      {children}
    </div>
  );
}

function Done({ icon, children }: { icon: "ok" | "off" | "error"; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-border bg-subtle px-3 py-2 text-sm text-fg-muted">
      {icon === "ok" ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <XCircle className={cn("mt-0.5 h-4 w-4 shrink-0", icon === "error" && "text-danger")} />
      )}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}
