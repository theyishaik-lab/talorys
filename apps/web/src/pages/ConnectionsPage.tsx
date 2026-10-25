import { useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Plug } from "lucide-react";
import { Badge, Button, ConfirmDialog, EmptyState, ErrorNotice, PageHeader, Spinner } from "../components/ui";
import { BellButton, MenuButton, TopBar } from "../components/AppShell";
import { keys, useApiMutation, useConnectionCatalog } from "../hooks/queries";
import { useConnections } from "../components/ConnectionsSection";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { useLocale, useT } from "../lib/i18n";
import { useNav } from "../lib/native";

interface Connection {
  service: string;
  account: string | null;
  auth_type: string | null;
  name: string | null;
}

function authLabel(t: ReturnType<typeof useT>, authType: string | null): string {
  if (!authType) return "";
  if (authType.startsWith("oauth")) return t("connections.authType.oauth2");
  if (authType === "api_key") return t("connections.authType.api_key");
  if (authType === "custom_credential") return t("connections.authType.custom_credential");
  return authType;
}

function ServiceRow({
  id,
  name,
  connection,
  configured,
  onDisconnect,
  connecting,
}: {
  id: string;
  name: string;
  connection: Connection | undefined;
  configured: boolean;
  onDisconnect: (service: string, displayName: string) => void;
  connecting: string | null;
}) {
  const t = useT();
  const { dir } = useLocale();
  const nav = useNav();
  const [expanded, setExpanded] = useState(false);
  const isConnected = !!connection;

  return (
    <li className="border-b border-border last:border-0">
      <button
        type="button"
        onClick={() => isConnected && setExpanded((v) => !v)}
        className={cn(
          "flex min-h-[54px] w-full items-center gap-3 px-4 py-3 text-start",
          isConnected && "pressable hover:bg-muted/40",
        )}
        aria-expanded={isConnected ? expanded : undefined}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-subtle text-fg-muted">
          <Plug className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[15px]">{name}</span>
          {isConnected && connection.account && (
            <span className="block truncate text-[12.5px] text-fg-muted" dir="ltr">{connection.account}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {isConnected ? (
            <Badge tone="success">{t("connections.connected")}</Badge>
          ) : (
            <span className="text-[13px] text-fg-subtle">{t("connections.notConnected")}</span>
          )}
          {isConnected && (
            expanded
              ? <ChevronLeft className={cn("h-4 w-4 text-fg-subtle", dir === "rtl" && "rtl:hidden")} />
              : <ChevronRight className={cn("h-4 w-4 text-fg-subtle", dir === "rtl" && "rtl:hidden")} />
          )}
        </span>
      </button>

      {isConnected && expanded && (
        <div className="bg-subtle/50 px-4 pb-3 pt-1 animate-fade-in">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1 text-[13px]">
              {connection.auth_type && (
                <p className="text-fg-muted">
                  {t("connections.authType.oauth2" as "connections.authType.oauth2")} · {authLabel(t, connection.auth_type)}
                </p>
              )}
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={() => onDisconnect(id, name)}
            >
              {t("connections.disconnect")}
            </Button>
          </div>
        </div>
      )}

      {!isConnected && configured && (
        <div className="bg-subtle/30 px-4 pb-3 pt-1">
          <p className="text-[12.5px] text-fg-muted">{t("connections.howToConnect", { name })}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            loading={connecting === id}
            onClick={() => nav(`/chat?prefill=${encodeURIComponent(`connect ${name}`)}`, "push")}
          >
            {t("connections.connect")}
          </Button>
        </div>
      )}
    </li>
  );
}

export default function ConnectionsPage() {
  const t = useT();
  const connections = useConnections();
  const catalog = useConnectionCatalog();
  const [disconnecting, setDisconnecting] = useState<{ service: string; name: string } | null>(null);
  const [connecting, _setConnecting] = useState<string | null>(null);

  const disconnect = useApiMutation(
    (service: string) => api(`/connections/${service}`, { method: "DELETE" }),
    {
      invalidate: [["connections"]],
      success: disconnecting ? t("connections.disconnected", { name: disconnecting.name }) : undefined,
      onSuccess: () => setDisconnecting(null),
    },
  );

  const isLoading = connections.isLoading || catalog.isLoading;
  const error = connections.error ?? catalog.error ?? (connections.data?.error ? new Error(connections.data.error) : null);

  const configured = connections.data?.configured ?? false;
  const activeMap = new Map<string, Connection>((connections.data?.connections ?? []).map((c) => [c.service, c]));
  const services = [...(catalog.data?.services ?? [])];
  for (const service of activeMap.keys()) {
    if (!services.some((item) => item.id === service)) services.push({ id: service, name: service });
  }

  const connected = services.filter((s) => activeMap.has(s.id));
  const available = services.filter((s) => !activeMap.has(s.id));

  return (
    <div className="flex h-full flex-col">
      <TopBar start={<MenuButton />} title={<h1 className="text-[16px] font-semibold">{t("connections.title")}</h1>} end={<BellButton />} />

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-2xl px-4 pb-10 pt-2 md:px-6">
          {isLoading ? (
            <div className="flex justify-center py-16"><Spinner /></div>
          ) : error ? (
            <ErrorNotice error={error} onRetry={() => { void connections.refetch(); void catalog.refetch(); }} />
          ) : !configured ? (
            <EmptyState icon={<Plug className="h-8 w-8" />} title={t("connections.unavailable")} />
          ) : (
            <div className="space-y-5">
              {connected.length > 0 && (
                <section>
                  <h2 className="mb-1.5 px-1 text-[12.5px] font-semibold uppercase tracking-wide text-fg-muted">
                    {t("connections.connected")}
                  </h2>
                  <div className="overflow-hidden rounded-xl bg-bg ring-1 ring-border">
                    <ul>
                      {connected.map((s) => (
                        <ServiceRow
                          key={s.id}
                          id={s.id}
                          name={s.name}
                          connection={activeMap.get(s.id)}
                          configured={configured}
                          onDisconnect={(service, name) => setDisconnecting({ service, name })}
                          connecting={connecting}
                        />
                      ))}
                    </ul>
                  </div>
                </section>
              )}

              {available.length > 0 && (
                <section>
                  <h2 className="mb-1.5 px-1 text-[12.5px] font-semibold uppercase tracking-wide text-fg-muted">
                    {t("connections.notConnected")}
                  </h2>
                  <div className="overflow-hidden rounded-xl bg-bg ring-1 ring-border">
                    <ul>
                      {available.map((s) => (
                        <ServiceRow
                          key={s.id}
                          id={s.id}
                          name={s.name}
                          connection={undefined}
                          configured={configured}
                          onDisconnect={(service, name) => setDisconnecting({ service, name })}
                          connecting={connecting}
                        />
                      ))}
                    </ul>
                  </div>
                </section>
              )}

              {connected.length === 0 && available.length === 0 && (
                <EmptyState icon={<Plug className="h-8 w-8" />} title={t("connections.empty")} />
              )}
            </div>
          )}
        </div>
      </div>

      {disconnecting && (
        <ConfirmDialog
          open
          title={t("connections.disconnectTitle", { name: disconnecting.name })}
          message={t("connections.disconnectMessage")}
          confirmLabel={t("connections.disconnect")}
          loading={disconnect.isPending}
          onConfirm={() => disconnect.mutate(disconnecting.service)}
          onCancel={() => setDisconnecting(null)}
        />
      )}
    </div>
  );
}
