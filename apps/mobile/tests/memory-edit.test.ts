import type { Memory } from "@talorys/shared";
import { MEMORY_CATEGORIES } from "@talorys/shared";
import { describe, expect, it } from "vitest";
import { translate } from "../src/lib/i18n";
import { canSaveMemory, initialMemoryDraft, MEMORY_MAX_CHARS, memorySaveRequest, memoryWriteMessage } from "../src/lib/memoryEdit";

const mem = (over: Partial<Memory> = {}): Memory => ({
  id: "m1",
  content: "Prefers concise answers",
  category: "preference",
  source: "manual",
  pinned: false,
  status: "active",
  superseded_by: null,
  valid_from: null,
  valid_until: null,
  created_at: "2026-11-06T10:00:00.000Z",
  updated_at: "2026-11-06T10:00:00.000Z",
  ...over,
});
const en = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("en", key, vars);
const he = (key: Parameters<typeof translate>[1], vars?: Record<string, string | number>) => translate("he", key, vars);

describe("memory editor", () => {
  it("adds with POST /memories and edits with PATCH /memories/:id, trimming the text", () => {
    expect(memorySaveRequest("new", "  Likes tea \n", "habit")).toEqual({ path: "/memories", method: "POST", body: { content: "Likes tea", category: "habit" } });
    expect(memorySaveRequest(mem({ id: "abc" }), "Likes coffee", "fact")).toEqual({ path: "/memories/abc", method: "PATCH", body: { content: "Likes coffee", category: "fact" } });
  });

  it("allows Save only with text that fits, and only when an edit changed something", () => {
    expect(canSaveMemory("new", "   ", "other")).toBe(false);
    expect(canSaveMemory("new", "x".repeat(MEMORY_MAX_CHARS + 1), "other")).toBe(false);
    expect(canSaveMemory("new", "שותה קפה שחור", "habit")).toBe(true);
    const m = mem();
    expect(canSaveMemory(m, m.content, m.category)).toBe(false);
    expect(canSaveMemory(m, `${m.content}  `, m.category)).toBe(false);
    expect(canSaveMemory(m, m.content, "fact")).toBe(true);
    expect(canSaveMemory(m, "Prefers short answers", m.category)).toBe(true);
  });

  it("starts from the memory's own values, or empty with Preferences for a new one", () => {
    expect(initialMemoryDraft("new")).toEqual({ content: "", category: "preference" });
    expect(initialMemoryDraft(mem({ content: "Has a daughter", category: "person" }))).toEqual({ content: "Has a daughter", category: "person" });
  });

  it("explains what Smart Memory did with the save, in both languages", () => {
    expect(memoryWriteMessage({ memory: mem() }, en)).toBe("Memory saved");
    expect(memoryWriteMessage({ memory: mem(), superseded: [mem()], reviews: 0 }, en)).toBe("Memory saved · the older version was kept as history");
    expect(memoryWriteMessage({ memory: mem(), superseded: [mem(), mem()], reviews: 1 }, en)).toBe(
      "Memory saved · 2 older versions were kept as history · it may conflict with an older memory — review it on the web Memory page",
    );
    expect(memoryWriteMessage({ memory: mem(), superseded: [mem()] }, he)).toBe("הזיכרון נשמר · הגרסה הקודמת נשמרה כהיסטוריה");
  });

  it("has a label for every shared memory category in both languages", () => {
    for (const cat of MEMORY_CATEGORIES) {
      const key = `m.memory.cat.${cat}` as Parameters<typeof translate>[1];
      expect(translate("en", key)).not.toBe(key);
      expect(translate("he", key)).not.toBe(translate("en", key));
    }
  });
});
