import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, migrate } from "../src/db/migrations";
import { MEMORY_SEARCH_TABLE, NOTE_SEARCH_TABLE, syncSearchIndex } from "../src/db/search-index";
import { ftsQuery, hebrewVariants, indexText, legacyFtsQuery, normalizeSearchText } from "../src/db/search-text";
import { inAgent } from "./helpers";

describe("Hebrew search text", () => {
  it("strips niqqud and cantillation, normalizes final letters, gershayim and maqaf", () => {
    expect(normalizeSearchText("הַפְּסַנְתֵּר")).toBe("הפסנתר");
    expect(normalizeSearchText("בְּרֵאשִׁ֖ית")).toBe("בראשית");
    expect(normalizeSearchText("שולחן ילדים עץ")).toBe("שולחנ ילדימ עצ");
    expect(normalizeSearchText('צה"ל וצה״ל ג\'ירפה')).toBe("צהל וצהל גירפה");
    expect(normalizeSearchText("תל־אביב")).toBe("תל אביב");
    expect(normalizeSearchText("Hello Café")).toBe("hello café");
  });

  it("strips up to two prefix letters, keeping stems of at least two letters", () => {
    expect(hebrewVariants("ובתל")).toEqual(["בתל", "תל"]);
    expect(hebrewVariants("שהילדה")).toEqual(["הילדה", "ילדה"]);
    expect(hebrewVariants("לבית")).toEqual(["בית", "ית"]);
    expect(hebrewVariants("תל")).toEqual([]);
    expect(hebrewVariants("בת")).toEqual([]);
    expect(hebrewVariants("וול")).toEqual(["ול"]); // ו only opens a word
    expect(hebrewVariants("talorys")).toEqual([]);
  });

  it("indexes normalized words and Hebrew stems separately", () => {
    expect(indexText("גר בתל־אביב עם הילדים")).toEqual({ body: "גר בתל אביב עמ הילדימ", stems: "תל ילדימ" });
    expect(indexText("Talorys keyboard")).toEqual({ body: "talorys keyboard", stems: "" });
  });

  it("keeps English queries as before and expands Hebrew words", () => {
    for (const q of ["What car do I drive?", "how often do i need to change the oil", "Talorys keyboard app on Android"]) {
      expect(ftsQuery(q)).toBe(legacyFtsQuery(q));
    }
    expect(ftsQuery("איפה אני גר בתל אביב?")).toBe('"גר"* OR "בתל"* OR "תל" OR "אביב"*');
    expect(ftsQuery("והילדה")).toBe('"והילדה"* OR "הילדה"* OR "ילדה"*');
    expect(ftsQuery("מה עם הַפְּסַנְתֵּר")).toBe('"הפסנתר"* OR "פסנתר"*');
    expect(ftsQuery("מה של זה")).toBeNull();
    expect(ftsQuery('a "quoted" OR NEAR(x) *')).toBe('"quoted"* OR "near"*');
  });
});

describe("Hebrew-aware memory and note search", () => {
  it("finds Hebrew memories through prefixes, niqqud and final letters", async () => {
    await inAgent((a) => {
      const repo = a.services.memories;
      const home = repo.create({ content: "גר בתל אביב ברחוב הזית מאז ספטמבר", category: "fact" });
      const piano = repo.create({ content: "מְנַגֵּן בַּפְּסַנְתֵּר כל ערב", category: "fact" });
      const table = repo.create({ content: "קנינו שולחנות מעץ זית לסלון", category: "fact" });
      const ids = (q: string) => repo.search(q, 8, undefined, "current").map((m) => m.id);
      expect(ids("והזית בתל אביב")).toContain(home.id);
      expect(ids("פסנתר")).toContain(piano.id);
      expect(ids("שולחן")).toContain(table.id);
      expect(ids("Tel Aviv")).not.toContain(piano.id);
    });
  });

  it("keeps the index in step with updates, deletes and raw writes", async () => {
    await inAgent((a) => {
      const repo = a.services.memories;
      const m = repo.create({ content: "החתול קוראים לו מיצי", category: "fact" });
      expect(repo.search("לחתול").map((x) => x.id)).toContain(m.id);
      repo.update(m.id, { content: "הכלב קוראים לו רקסי" });
      expect(repo.search("לחתול").map((x) => x.id)).not.toContain(m.id);
      expect(repo.search("ולכלב").map((x) => x.id)).toContain(m.id);
      a.services.db.run(
        `INSERT INTO tal_memories (id, content, category, source, status, superseded_by, valid_from, valid_until, created_at, updated_at)
         VALUES ('raw-hebrew-1', 'מעדיף קפה הפוך בכוס זכוכית', 'preference', 'manual', 'active', NULL, NULL, NULL, '2026-11-06T10:00:00Z', '2026-11-06T10:00:00Z')`,
      );
      expect(repo.search("בכוסות זכוכית").map((x) => x.id)).toContain("raw-hebrew-1");
      repo.delete(m.id);
      expect(repo.search("ולכלב").map((x) => x.id)).not.toContain(m.id);
      expect(a.services.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_search_dirty`)?.n).toBe(0);
    });
  });

  it("searches note titles and bodies in Hebrew", async () => {
    await inAgent((a) => {
      const note = a.services.notes.create({ title: "רשימת קניות לבית", content: "חלב, לחם, עגבניות" });
      expect(a.services.notes.search("הקניות").map((n) => n.id)).toContain(note.id);
      expect(a.services.notes.search("ועגבניות").map((n) => n.id)).toContain(note.id);
    });
  });

  it("migration 16 reindexes rows written before it", async () => {
    await inAgent((a) => {
      const db = a.services.db;
      const m = a.services.memories.create({ content: "הבת שלי לומדת בגן הדקל", category: "fact" });
      db.run(`DROP TABLE ${MEMORY_SEARCH_TABLE}`);
      db.run(`DROP TABLE ${NOTE_SEARCH_TABLE}`);
      db.run(`DROP TABLE tal_search_dirty`);
      for (const t of ["memories", "notes"]) for (const s of ["ai", "ad", "au"]) db.run(`DROP TRIGGER IF EXISTS tal_${t}_search_${s}`);
      db.run(`UPDATE tal_schema SET version = 15 WHERE id = 1`);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(syncSearchIndex(db)).toBeGreaterThan(0);
      expect(a.services.memories.search("שבגן הדקל").map((x) => x.id)).toContain(m.id);
      expect(migrate(db)).toBe(LATEST_SCHEMA_VERSION);
    });
  });

  it("falls back to the legacy index when the Hebrew index is missing", async () => {
    await inAgent((a) => {
      const db = a.services.db;
      const m = a.services.memories.create({ content: "Favourite hummus place is near the market", category: "preference" });
      db.run(`DROP TABLE ${MEMORY_SEARCH_TABLE}`);
      expect(a.services.memories.search("hummus").map((x) => x.id)).toContain(m.id);
    });
  });
});
