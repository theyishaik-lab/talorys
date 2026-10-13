import { selectRelevantMemories } from "../agent/memory";
import type { Env } from "../env";
import type { RunnerExtensions } from "../semantic/hooks";
import type { Services } from "../services/container";
import { ALL_TOOLS, type ToolDefinition } from "../tools";
import { OpenConnectorClient } from "./client";
import { connectTools, OpenConnectorAdmin } from "./connect";
import { openConnectorTools } from "./tools";

export { OpenConnectorClient } from "./client";
export { connectionStatus, OpenConnectorAdmin, refreshConnectLink } from "./connect";
export { isReadOnlyAction, openConnectorTools } from "./tools";

/**
 * The admin side, or null when the admin token or the URL is missing. The connect tools (adding
 * an app from the chat) are off without it; everything else works on the runtime token alone.
 */
export function openConnectorAdmin(env: Env): OpenConnectorAdmin | null {
  const adminToken = env.OPEN_CONNECTOR_ADMIN_TOKEN?.trim();
  const url = env.OPEN_CONNECTOR_URL?.trim();
  if (!adminToken || !url) return null;
  return new OpenConnectorAdmin({ url, adminToken });
}

/** The runtime tools plus, when the admin side is configured, the two connect tools. */
function allConnectorTools(env: Env, client: OpenConnectorClient): ToolDefinition[] {
  const admin = openConnectorAdmin(env);
  return admin ? [...openConnectorTools(client), ...connectTools(admin, client)] : openConnectorTools(client);
}

/**
 * The OpenConnector client for this deployment, or null when it is not configured. Configured
 * means the runtime token secret plus either a service binding to the connector Worker or its URL.
 */
export function openConnectorClient(env: Env): OpenConnectorClient | null {
  const token = env.OPEN_CONNECTOR_TOKEN?.trim();
  if (!token) return null;
  const url = env.OPEN_CONNECTOR_URL?.trim();
  if (!env.OPEN_CONNECTOR && !url) return null;
  return new OpenConnectorClient({ binding: env.OPEN_CONNECTOR, url, token });
}

/** Upstream tools plus the connector tools when configured; the approve route uses the same set. */
export function toolsWithOpenConnector(env: Env, base: ToolDefinition[] = ALL_TOOLS): ToolDefinition[] {
  const client = openConnectorClient(env);
  return client ? [...base, ...allConnectorTools(env, client)] : base;
}

/**
 * Runner extensions with the connector tools appended to whatever tool set the semantic module
 * chose (or upstream's), and the prompt told that external apps are reachable. Without a
 * configured connector the extensions pass through unchanged.
 */
export function withOpenConnector(ext: RunnerExtensions | undefined, services: Services, env: Env): RunnerExtensions | undefined {
  const client = openConnectorClient(env);
  if (!client) return ext;
  return {
    selectMemories: ext?.selectMemories ?? (async (query) => selectRelevantMemories(services.memories, query)),
    tools: [...(ext?.tools ?? ALL_TOOLS), ...allConnectorTools(env, client)],
    connectors: true,
  };
}
