import { useQuery } from "@tanstack/react-query";
import { Plug } from "lucide-react";
import { api } from "../lib/api";
import { useT } from "../lib/i18n";
import { Spinner } from "./ui";

interface ConnectionsResponse {
  configured: boolean;
  connections: { service: string; account: string | null; auth_type: string | null; name: string | null }[];
  error?: string;
}

/** Known service names as the connector spells them (the chat's connect cards use the same ids). */
const SERVICE_NAMES: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googledocs: "Google Docs",
  googlesheets: "Google Sheets",
  googletasks: "Google Tasks",
  github: "GitHub",
  notion: "Notion",
  slack: "Slack",
  linear: "Linear",
  todoist: "Todoist",
  trello: "Trello",
};

export function useConnections() {
  return useQuery({ queryKey: ["connections"], queryFn: () => api<ConnectionsResponse>("/connections"), staleTime: 60_000 });
}

/** Settings → Connections: what is connected through the connector, with the account on each. */
export function ConnectionsSection() {
  const t = useT();
  const q = useConnections();
  if (q.isLoading) {
    return (
      <div className="flex min-h-[50px] items-center px-3.5">
        <Spinner className="h-4 w-4" />
      </div>
    );
  }
  const data = q.data;
  if (!data?.configured) return <p className="px-3.5 py-3 text-[13px] text-fg-muted">{t("settings.connectionsUnavailable")}</p>;
  if (data.error) return <p className="px-3.5 py-3 text-[13px] text-fg-muted">{t("settings.connectionsError", { error: data.error })}</p>;
  if (data.connections.length === 0) return <p className="px-3.5 py-3 text-[13px] text-fg-muted">{t("settings.connectionsNone")}</p>;
  return (
    <ul data-testid="connections">
      {data.connections.map((c) => (
        <li key={`${c.service}-${c.name ?? ""}`} className="flex min-h-[50px] items-center gap-3 px-3.5 text-[15px]">
          <span className="grid w-[22px] place-items-center text-fg-muted" aria-hidden>
            <Plug className="h-[19px] w-[19px]" />
          </span>
          <span className="min-w-0 flex-1 truncate">{SERVICE_NAMES[c.service] ?? c.service}</span>
          <span className="flex items-center gap-2 text-sm text-fg-muted">
            {c.account && (
              <span dir="ltr" className="max-w-[160px] truncate">
                {c.account}
              </span>
            )}
            <span className="h-2 w-2 rounded-full bg-success" title={t("model.connected")} />
          </span>
        </li>
      ))}
    </ul>
  );
}
