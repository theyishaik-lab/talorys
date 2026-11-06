import type { Memory, MemoryCategory } from "@talorys/shared";
import type { StringKey } from "./i18n";

/** Same cap as memoryCreateSchema / memoryUpdateSchema in packages/shared (content: shortText(2000)). */
export const MEMORY_MAX_CHARS = 2000;

/** What the editor is open for: a new memory, or an existing one. */
export type MemoryEditTarget = Memory | "new";

/** What the server answers to POST /memories and PATCH /memories/:id (same shape the web Memory page reads). */
export interface MemoryWriteResponse {
  memory: Memory;
  superseded?: Memory[];
  reviews?: number;
}

/** The request that saves the editor: POST for a new memory, PATCH for an edit (same as the web MemoryEditor). */
export function memorySaveRequest(target: MemoryEditTarget, content: string, category: MemoryCategory): { path: string; method: "POST" | "PATCH"; body: { content: string; category: MemoryCategory } } {
  const body = { content: content.trim(), category };
  return target === "new" ? { path: "/memories", method: "POST", body } : { path: `/memories/${target.id}`, method: "PATCH", body };
}

/** Save is allowed when there is text, it fits, and (for an edit) something actually changed. */
export function canSaveMemory(target: MemoryEditTarget, content: string, category: MemoryCategory): boolean {
  const text = content.trim();
  if (!text || text.length > MEMORY_MAX_CHARS) return false;
  if (target === "new") return true;
  return text !== target.content || category !== target.category;
}

/** The editor's starting values: the memory's own, or empty with "preference" for a new one (as on the web). */
export function initialMemoryDraft(target: MemoryEditTarget): { content: string; category: MemoryCategory } {
  return target === "new" ? { content: "", category: "preference" } : { content: target.content, category: target.category };
}

/** Explains what Smart Memory did with a save, in plain words (mirrors writeMessage on the web Memory page). */
export function memoryWriteMessage(r: MemoryWriteResponse, t: (key: StringKey, vars?: Record<string, string | number>) => string): string {
  const parts = [t("m.memory.saved")];
  const n = r.superseded?.length ?? 0;
  if (n) parts.push(n === 1 ? t("m.memory.supersededOne") : t("m.memory.supersededMany", { n }));
  if (r.reviews) parts.push(t("m.memory.mayConflict"));
  return parts.join(" · ");
}
