import { MEMORY_CATEGORIES } from "@talorys/shared";
import { z } from "zod";
import { defineTool, quoteTitle, ToolError } from "./registry";
import { hasHistoricalIntent } from "../memory/intent";
import { ValidationError } from "../api/errors";

export const memoryTools = [
  defineTool({
    name: "remember",
    description:
      "Store a durable fact about the owner (preference, goal, habit, person, important fact or date) so you know it in later chats. Use it as your memory rules say: when the owner asks you to remember something, and — when learning from conversations is on — whenever they share something lasting about themselves. Write it as a short third-person statement.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({
      content: z.string().min(3).max(1000),
      category: z.enum(MEMORY_CATEGORIES).optional(),
      pin: z
        .boolean()
        .optional()
        .describe("Pin as core memory (shown in every chat). Only when the owner explicitly says to ALWAYS remember this; never on your own initiative."),
    }),
    label: (i) => (i.pin ? `Pinning to core memory` : `Saving to memory`),
    execute: async (i, ctx) => {
      if (i.pin && ctx.mode === "scheduled") throw new ToolError("Core memory can only be pinned in a live chat at the owner's request.");
      let result: Awaited<ReturnType<typeof ctx.services.memoryHistory.create>>;
      try {
        result = await ctx.services.memoryHistory.create({ content: i.content, category: i.category ?? "other", source: "agent", pinned: i.pin === true });
      } catch (error) {
        if (i.pin && error instanceof ValidationError) throw new ToolError(`${error.message} The owner can manage core memory on the Memory page.`);
        throw error;
      }
      const { memory, superseded, reviews } = result;
      ctx.services.activity.record("memory.created", `Agent remembered: ${memory.content}`);
      return {
        remembered: { id: memory.id, content: memory.content, category: memory.category, ...(memory.pinned ? { pinned: true } : {}) },
        ...(superseded.length ? { now_historical: superseded.map((m) => ({ id: m.id, content: m.content })) } : {}),
        ...(reviews.length ? { needs_owner_review: "This may conflict with an older memory; both are kept until the owner reviews it on the Memory page." } : {}),
      };
    },
  }),
  defineTool({
    name: "search_memories",
    description:
      "Search what you remember about the owner. Results marked historical are past facts that are no longer true; set include_history for questions about the past.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ query: z.string().min(1).max(200), include_history: z.boolean().optional() }),
    label: (i) => `Recalling “${i.query}”`,
    execute: (i, ctx) => ({
      memories: ctx.services.memories
        .search(i.query, 10, undefined, (i.include_history ?? hasHistoricalIntent(i.query)) ? "all" : "current")
        .map((m) => ({ id: m.id, content: m.content, category: m.category, ...(m.status !== "active" ? { status: m.status } : {}), ...(m.pinned ? { pinned: true } : {}) })),
    }),
  }),
  defineTool({
    name: "update_memory",
    description: "Correct or refine an existing memory by id.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1), content: z.string().min(3).max(1000), category: z.enum(MEMORY_CATEGORIES).optional() }),
    label: () => `Updating a memory`,
    execute: async (i, ctx) => {
      const existing = ctx.services.memories.get(i.id);
      if (!existing) throw new ToolError("Memory not found.");
      // Core memory changes only by the owner: they edit it on the Memory page.
      if (existing.pinned) throw new ToolError("This is a pinned core memory; only the owner can change it (Memory page).");
      const { memory: m } = await ctx.services.memoryHistory.update(i.id, { content: i.content, category: i.category });
      return { updated: { id: m.id, content: m.content } };
    },
  }),
  defineTool({
    name: "forget_memory",
    description: "Propose deleting a memory by id. The owner must approve it in the app before anything is deleted.",
    permission: "destructive",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1) }),
    label: () => `Proposing to forget a memory`,
    prepare: (i, ctx) => {
      const m = ctx.services.memories.get(i.id);
      if (!m) throw new ToolError("Memory not found.");
      return { targetId: m.id, summary: `Forget memory ${quoteTitle(m.content)}` };
    },
    commit: (id, ctx) => {
      const m = ctx.services.memories.get(id);
      if (!m) throw new ToolError("This memory no longer exists.");
      ctx.services.memoryHistory.delete(m.id);
      ctx.services.activity.record("memory.deleted", "Forgot a memory (approved agent action)");
    },
  }),
];
