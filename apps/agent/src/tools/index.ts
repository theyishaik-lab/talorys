import type { ToolDefinition } from "./registry";
import { taskTools } from "./tasks";
import { noteTools, projectTools } from "./notes";
import { memoryTools } from "./memories";
import { reminderTools } from "./reminders";
import { searchTools } from "./search";
import { proactiveTools } from "./proactive";
import { contextTools } from "./context";
import { httpTools } from "../http/tools";

/**
 * Every tool available to the agent. To add a capability, create a module with
 * `defineTool(...)` entries and add it here. Tools may only touch the owner's
 * own data through the service layer: no shell, code execution or credentials.
 * The one network tool, `http_request` (../http), reaches public hosts only
 * (SSRF guard), injects saved keys without the model seeing them, and sends
 * anything other than GET through the owner's approval by default.
 */
export const ALL_TOOLS: ToolDefinition[] = [
  ...taskTools,
  ...noteTools,
  ...projectTools,
  ...memoryTools,
  ...reminderTools,
  ...searchTools,
  ...proactiveTools,
  ...contextTools,
  ...httpTools,
] as ToolDefinition[];

const names = new Set<string>();
for (const t of ALL_TOOLS) {
  if (names.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
  names.add(t.name);
}

export { runApprovedAction, ToolExecutor, ToolError, type ToolContext, type ToolDefinition } from "./registry";
