import type { ApiConnectionView, ApiConnectionsResponse } from "@talorys/shared";
import { useQuery } from "@tanstack/react-query";
import { Globe, KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { useApiMutation } from "../hooks/queries";
import { errorMessage, useToast } from "../hooks/toast";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { Button, ConfirmDialog, Dialog, ErrorNotice, Input, Spinner, Switch } from "./ui";

type SectionC = (p: { title?: string; children: ReactNode; inset?: boolean }) => ReactNode;
type RowC = (p: { label: string; hint?: ReactNode; children: ReactNode }) => ReactNode;

export const apiConnectionsKey = ["http", "connections"] as const;

export function useApiConnections() {
  return useQuery({ queryKey: apiConnectionsKey, queryFn: () => api<ApiConnectionsResponse>("/http/connections"), staleTime: 30_000 });
}

/**
 * Settings → API connections: the APIs the agent's `http_request` tool may call with a saved key.
 * The key goes to the agent once and is stored encrypted there; only its last four characters
 * ever come back (`…k2Q9`).
 */
export function ApiConnectionsTab({ Section, Row }: { Section: SectionC; Row: RowC }) {
  const t = useT();
  const q = useApiConnections();
  const [editing, setEditing] = useState<ApiConnectionView | "new" | null>(null);
  const [deleting, setDeleting] = useState<ApiConnectionView | null>(null);
  const setConfirm = useApiMutation((confirmNonGet: boolean) => api("/http/settings", { method: "PUT", body: { confirmNonGet } }), { invalidate: [apiConnectionsKey] });
  const remove = useApiMutation((id: string) => api(`/http/connections/${id}`, { method: "DELETE" }), {
    invalidate: [apiConnectionsKey],
    success: t("http.deleted"),
    onSuccess: () => setDeleting(null),
  });

  if (q.error) return <ErrorNotice error={q.error} onRetry={() => void q.refetch()} />;
  if (q.isLoading || !q.data) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }
  const { connections, settings, secrets_available } = q.data;
  const confirmOn = setConfirm.isPending ? !!setConfirm.variables : settings.confirmNonGet;

  return (
    <>
      <p className="px-2 text-[13px] leading-5 text-fg-muted">{t("http.intro")}</p>
      <Section title={t("http.list")} inset>
        {connections.length === 0 ? (
          <p className="px-3.5 py-3 text-[13px] text-fg-muted">{t("http.none")}</p>
        ) : (
          <ul data-testid="api-connections">
            {connections.map((c) => (
              <li key={c.id} className="flex min-h-[58px] items-center gap-3 px-3.5 py-2">
                <span className="grid w-[22px] place-items-center text-fg-muted" aria-hidden>
                  <Globe className="h-[19px] w-[19px]" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[15px]" dir="auto">
                    {c.name}
                  </p>
                  <p className="truncate text-[12.5px] text-fg-muted" dir="ltr" style={{ textAlign: "start" }}>
                    {c.baseURL}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-[12px] text-fg-subtle">
                    <KeyRound className="h-3 w-3" aria-hidden />
                    {c.secret.set ? (
                      <span>
                        <span dir="ltr">{c.authHeader}</span> · <span dir="ltr">{c.secret.hint}</span>
                      </span>
                    ) : (
                      t("http.noSecret")
                    )}
                  </p>
                </div>
                <Button variant="ghost" size="icon" aria-label={`${t("http.edit")} ${c.name}`} onClick={() => setEditing(c)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label={`${t("common.delete")} ${c.name}`} onClick={() => setDeleting(c)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" onClick={() => setEditing("new")} className="pressable flex min-h-[50px] w-full items-center gap-3 px-3.5 text-start text-[15px] text-accent-text hover:bg-muted/60">
          <span className="grid w-[22px] place-items-center" aria-hidden>
            <Plus className="h-[19px] w-[19px]" />
          </span>
          {t("http.add")}
        </button>
      </Section>
      {!secrets_available && <p className="px-2 text-[12.5px] text-danger">{t("http.secretsUnavailable")}</p>}
      <Section title={t("http.safety")}>
        <Row label={t("http.confirm")} hint={t("http.confirmHint")}>
          <div className="flex justify-end">
            <Switch checked={confirmOn} onChange={(v) => setConfirm.mutate(v)} label={t("http.confirm")} disabled={setConfirm.isPending} />
          </div>
        </Row>
        <p className="px-4 pb-3.5 text-[12.5px] leading-5 text-fg-muted">{t("http.guard")}</p>
      </Section>
      <ConnectionDialog key={editing === "new" ? "new" : (editing?.id ?? "none")} connection={editing} secretsAvailable={secrets_available} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        title={t("http.deleteTitle")}
        message={t("http.deleteMessage", { name: deleting?.name ?? "" })}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
        loading={remove.isPending}
      />
    </>
  );
}

function ConnectionDialog({ connection, secretsAvailable, onClose }: { connection: ApiConnectionView | "new" | null; secretsAvailable: boolean; onClose: () => void }) {
  const t = useT();
  const toast = useToast();
  const existing = connection && connection !== "new" ? connection : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [baseURL, setBaseURL] = useState(existing?.baseURL ?? "https://");
  const [authHeader, setAuthHeader] = useState(existing?.authHeader ?? "Authorization");
  const [secret, setSecret] = useState("");
  const [removeSecret, setRemoveSecret] = useState(false);
  const save = useApiMutation(
    (body: Record<string, unknown>) => (existing ? api(`/http/connections/${existing.id}`, { method: "PUT", body }) : api("/http/connections", { method: "POST", body })),
    { invalidate: [apiConnectionsKey], success: t("http.saved"), onSuccess: onClose },
  );
  const https = baseURL.trim() === "" || baseURL.trim().startsWith("https://");
  const ready = name.trim().length > 0 && /^https:\/\/[^/\s]+\.[^\s]+/.test(baseURL.trim()) && /^[A-Za-z0-9-]+$/.test(authHeader.trim());

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    const body: Record<string, unknown> = { name: name.trim(), baseURL: baseURL.trim(), authHeader: authHeader.trim() };
    if (secret.trim()) body.secret = secret.trim();
    else if (existing && removeSecret) body.secret = null;
    save.mutate(body, { onError: (err) => toast(errorMessage(err), "error") });
  }

  return (
    <Dialog open={connection !== null} onClose={onClose} title={existing ? t("http.edit") : t("http.add")}>
      <form className="space-y-3" onSubmit={submit}>
        <label className="block text-[13px] font-medium">
          {t("http.name")}
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("http.namePlaceholder")} maxLength={60} dir="auto" required />
        </label>
        <label className="block text-[13px] font-medium">
          {t("http.baseURL")}
          <Input className="mt-1" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://api.example.com/v1" dir="ltr" inputMode="url" required />
          {!https && <span className="mt-1 block text-[12px] text-danger">{t("http.httpsOnly")}</span>}
        </label>
        <label className="block text-[13px] font-medium">
          {t("http.authHeader")}
          <Input className="mt-1" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} placeholder="Authorization" dir="ltr" maxLength={60} />
          <span className="mt-1 block text-[12px] font-normal text-fg-muted">{t("http.authHeaderHint")}</span>
        </label>
        <label className="block text-[13px] font-medium">
          {t("http.secret")}
          <Input
            className="mt-1"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            type="password"
            autoComplete="off"
            dir="ltr"
            disabled={!secretsAvailable || removeSecret}
            placeholder={existing?.secret.set ? existing.secret.hint ?? "" : "Bearer …"}
          />
          <span className="mt-1 block text-[12px] font-normal text-fg-muted">{existing?.secret.set ? t("http.secretKeep", { hint: existing.secret.hint ?? "" }) : t("http.secretHint")}</span>
        </label>
        {existing?.secret.set && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={removeSecret} onChange={(e) => setRemoveSecret(e.target.checked)} />
            {t("http.secretRemove")}
          </label>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" loading={save.isPending} disabled={!ready}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
