import type { Suggestion } from "@talorys/shared";
import { z } from "zod";
import { defineTool, ToolError } from "./registry";

function present(s: Suggestion) {
  return { id: s.id, kind: s.kind, title: s.title, body: s.body, status: s.status };
}

export const proactiveTools = [
  defineTool({
    name: "list_suggestions",
    description:
      "List the owner's open proactive suggestions (things the agent noticed and surfaced, e.g. overdue tasks). Use when the owner asks what you've spotted or what needs attention.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    label: () => "Checking proactive suggestions",
    execute: (i, ctx) => {
      const items = ctx.services.suggestions.list({ limit: i.limit ?? 25 });
      return { count: items.length, suggestions: items.map(present) };
    },
  }),
  defineTool({
    name: "dismiss_suggestion",
    description: "Dismiss a proactive suggestion the owner is not interested in, so it stops being surfaced.",
    permission: "write",
    maxCallsPerTurn: 10,
    input: z.object({ id: z.string().min(1).describe("The suggestion id from list_suggestions") }),
    label: (i) => `Dismissing suggestion ${i.id}`,
    execute: (i, ctx) => {
      const existing = ctx.services.suggestions.get(i.id);
      if (!existing) throw new ToolError("No suggestion with that id.");
      const updated = ctx.services.suggestions.setStatus(i.id, "dismissed");
      return { dismissed: updated ? present(updated) : null };
    },
  }),
];
