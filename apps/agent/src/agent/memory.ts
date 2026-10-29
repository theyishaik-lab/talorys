import type { ChatMessage, Limits, Memory } from "@talorys/shared";
import type { MemoryRepository } from "../db/repositories/memories";
import { estimateTokens, type ModelMessage } from "../ai/provider";
import { hasHistoricalIntent } from "../memory/intent";
import { CONTEXT_BUDGETS, type ContextBudgets } from "./context";

const MAX_RELEVANT_MEMORIES = 8;
const ALWAYS_INCLUDE_PREFERENCES = 4;

/**
 * Keyword selection (used when semantic recall is off): full-text matches first, plus a
 * few of the most recently updated preferences. Past facts are left out unless the question
 * is about the past; then earlier versions of the matched facts come along too.
 */
export function selectRelevantMemories(repo: MemoryRepository, query: string): Memory[] {
  const past = hasHistoricalIntent(query);
  const selected = new Map<string, Memory>();
  for (const m of repo.search(query, MAX_RELEVANT_MEMORIES, undefined, past ? "all" : "current")) selected.set(m.id, m);
  if (past) {
    for (const m of [...selected.values()]) {
      for (const p of repo.predecessors(m.id)) if (selected.size < MAX_RELEVANT_MEMORIES) selected.set(p.id, p);
    }
  }
  for (const m of repo.list({ category: "preference", limit: ALWAYS_INCLUDE_PREFERENCES, status: "active" })) {
    if (selected.size >= MAX_RELEVANT_MEMORIES) break;
    selected.set(m.id, m);
  }
  return [...selected.values()];
}

/**
 * Prompt tokens reserved for memories: a fifth of the context budget, at most 1,500,
 * so memories never crowd out instructions or recent conversation.
 */
export function memoryTokenBudget(limits: Limits): number {
  return Math.min(1500, Math.floor(limits.maxContextTokens * 0.2));
}

export interface ContextWindow {
  messages: ModelMessage[];
  /** Messages that no longer fit and are not yet covered by the summary, oldest first. */
  overflow: ChatMessage[];
}

/**
 * Fits the most recent messages into `maxTokens`, oldest dropped first (they become `overflow`,
 * which compaction folds into the summary; see context.ts). Messages already covered by the
 * conversation summary are never resent. One huge message is clipped instead of pushing everything
 * else out, and the newest `recentMinMessages` always stay, each clipped to share the budget.
 */
export function buildContextWindow(history: ChatMessage[], maxTokens: number, summaryUpto: string | null, b: ContextBudgets = CONTEXT_BUDGETS): ContextWindow {
  const eligible = history.filter((m) => m.content.trim().length > 0 && (!summaryUpto || m.created_at > summaryUpto));
  const perMessage = Math.min(b.messageMaxTokens, Math.max(64, Math.floor(maxTokens / Math.max(1, Math.min(b.recentMinMessages, eligible.length)))));
  const clipTo = (m: ChatMessage, tokens: number) => (estimateTokens(m.content) > tokens ? `${m.content.slice(0, tokens * 4)}\n…[clipped]` : m.content);
  const kept: { m: ChatMessage; content: string }[] = [];
  let used = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const m = eligible[i]!;
    let content = clipTo(m, b.messageMaxTokens);
    let cost = estimateTokens(content) + 4;
    if (kept.length === 0 && cost > maxTokens) {
      // The newest message alone is over budget: keep it, clipped, with room left for a little context.
      content = clipTo(m, Math.max(perMessage, Math.floor(maxTokens * 0.5)));
      cost = estimateTokens(content) + 4;
    } else if (kept.length > 0 && used + cost > maxTokens) {
      if (kept.length >= b.recentMinMessages) break;
      // One of the newest few: keep it, clipped to its share.
      content = clipTo(m, perMessage);
      cost = estimateTokens(content) + 4;
      if (used + cost > maxTokens * 1.25) break;
    }
    kept.unshift({ m, content });
    used += cost;
  }
  // Models expect the conversation to start with a user turn. A thread that opens with notifications
  // (assistant messages written by automations) keeps them, behind a short user turn that frames them.
  const firstUser = history.findIndex((m) => m.role === "user");
  const leadsWithNotices = kept.length > 0 && kept[0]!.m.role !== "user" && (firstUser === -1 || history.indexOf(kept[0]!.m) < firstUser);
  if (!leadsWithNotices) while (kept.length > 1 && kept[0]!.m.role !== "user") kept.shift();
  const overflow = eligible.slice(0, eligible.length - kept.length);
  const messages: ModelMessage[] = kept.map(({ m, content }) => ({ role: m.role, content }));
  if (leadsWithNotices) messages.unshift({ role: "user", content: "(The messages that follow are notifications you sent me earlier.)" });
  return { messages, overflow };
}
