import { selectRelevantMemories } from "../agent/memory";
import type { Env } from "../env";
import type { RunnerExtensions } from "../semantic/hooks";
import type { Services } from "../services/container";
import { ALL_TOOLS, type ToolDefinition } from "../tools";
import { OpenConnectorClient } from "./client";
import { openConnectorTools } from "./tools";

export { OpenConnectorClient } from "./client";
export { isReadOnlyAction, openConnectorTools } from "./tools";

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
  return client ? [...base, ...openConnectorTools(client)] : base;
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
    tools: [...(ext?.tools ?? ALL_TOOLS), ...openConnectorTools(client)],
    connectors: true,
  };
}
