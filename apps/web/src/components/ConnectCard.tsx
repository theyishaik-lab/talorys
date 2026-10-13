import { type ReactNode, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConnectCard as ConnectCardData, PendingAction } from "@talorys/shared";
import { CheckCircle2, ExternalLink, KeyRound, Loader2, Plug, XCircle } from "lucide-react";
import { keys, useApiMutation } from "../hooks/queries";
import { api } from "../lib/api";
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

/** Hebrew when the page or the browser says so; the shell's locale setting (when present) wins through <html lang>. */
function strings() {
  if (typeof document === "undefined") return STRINGS.en;
  const lang = document.documentElement.lang || navigator.language || "";
  return /^he/i.test(lang) ? STRINGS.he : STRINGS.en;
}

export function ConnectCard({ action: initial }: { action: PendingAction & { card: ConnectCardData } }) {
  const t = strings();
  const qc = useQueryClient();
  const [action, setAction] = useState<PendingAction>(initial);
  useEffect(() => setAction(initial), [initial]);
  const card = (action.card ?? initial.card) as ConnectCardData;
  const [values, setValues] = useState<Record<string, string>>({});
  const [account, setAccount] = useState<string | null>(card.account ?? null);

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
  if (awaitingSignIn && card.authorization_url) {
    return (
      <div role="group" aria-label="Sign in" className="rounded-lg border border-border bg-surface px-3 py-2.5 shadow-sm">
        <div className="flex items-start gap-2 text-sm">
          <Plug className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <p className="break-words font-medium text-fg">{card.name}</p>
            <p className="flex items-center gap-1.5 text-xs text-fg-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> {t.waiting}
            </p>
          </div>
        </div>
        <div className="mt-2.5 flex justify-end">
          <a
            href={card.authorization_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg shadow-sm hover:opacity-90"
          >
            <ExternalLink className="h-3.5 w-3.5" /> {t.openSignIn(card.name)}
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
    <div role="group" aria-label="Connection approval" className="rounded-lg border border-accent/40 bg-surface px-3 py-2.5 shadow-sm">
      <div className="flex items-start gap-2 text-sm">
        {card.method === "api_key" ? <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-accent" /> : <Plug className="mt-0.5 h-4 w-4 shrink-0 text-accent" />}
        <div className="min-w-0 flex-1">
          <p className="break-words font-medium text-fg">{t.title(card.name)}</p>
          <p className="text-xs text-fg-muted">{card.method === "oauth" ? t.oauthHint : t.keyHint}</p>
        </div>
      </div>
      {card.method === "api_key" && fields.length > 0 && (
        <form
          className="mt-2.5 space-y-2"
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
      <div className="mt-2.5 flex justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={decide.isPending} onClick={() => decide.mutate("cancel")}>
          {t.decline}
        </Button>
        <Button
          size="sm"
          variant="primary"
          loading={decide.isPending && decide.variables === "approve"}
          disabled={decide.isPending || (card.method === "api_key" && !filled)}
          onClick={() => decide.mutate("approve")}
        >
          {t.approve}
        </Button>
      </div>
    </div>
  );
}

function Done({ icon, children }: { icon: "ok" | "off" | "error"; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-subtle px-3 py-2 text-sm text-fg-muted">
      {icon === "ok" ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <XCircle className={cn("mt-0.5 h-4 w-4 shrink-0", icon === "error" && "text-danger")} />
      )}
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}
