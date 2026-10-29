import { describe, expect, it } from "vitest";
import { client, inAgent, loggedIn, password } from "./helpers";
import { KEYBOARD_MAX_BIGRAMS, KEYBOARD_MAX_BODY_BYTES, KEYBOARD_MAX_WORDS, mergeDictionaries, type KeyboardDictionary } from "../src/keyboard/dictionary";

const dict = (p: Partial<KeyboardDictionary> = {}): KeyboardDictionary => ({ schema: 1, updatedAt: 1000, words: [], bigrams: [], ...p });

async function nativeToken(): Promise<string> {
  const res = await client().call("/api/auth/login", { method: "POST", body: { password: password() }, headers: { "x-talorys-client": "native" } });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

async function clear() {
  await inAgent((a) => a.services.db.run(`DELETE FROM tal_keyboard_dictionary`));
}

describe("keyboard dictionary merge", () => {
  it("unions by key and takes max count / max lastUsed", () => {
    const out = mergeDictionaries(
      dict({ words: [{ w: "שלום", lang: "he", count: 5, lastUsed: 10 }, { w: "hi", lang: "en", count: 1, lastUsed: 1 }] }),
      dict({ words: [{ w: "שלום", lang: "he", count: 2, lastUsed: 20 }, { w: "hi", lang: "he", count: 3, lastUsed: 3 }] }),
      50,
    );
    expect(out.words).toEqual([
      { w: "שלום", lang: "he", count: 5, lastUsed: 20 },
      { w: "hi", lang: "en", count: 1, lastUsed: 1 },
      { w: "hi", lang: "he", count: 3, lastUsed: 3 },
    ]);
    expect(out.schema).toBe(1);
    expect(out.updatedAt).toBe(1000);
  });

  it("deleted wins when its lastUsed is >= the other side's, loses otherwise", () => {
    const tie = mergeDictionaries(dict({ words: [{ w: "a", lang: "en", count: 4, lastUsed: 10 }] }), dict({ words: [{ w: "a", lang: "en", count: 1, lastUsed: 10, deleted: true }] }));
    expect(tie.words[0]).toEqual({ w: "a", lang: "en", count: 4, lastUsed: 10, deleted: true });
    const older = mergeDictionaries(dict({ words: [{ w: "a", lang: "en", count: 4, lastUsed: 11 }] }), dict({ words: [{ w: "a", lang: "en", count: 1, lastUsed: 10, deleted: true }] }));
    expect(older.words[0]).toEqual({ w: "a", lang: "en", count: 4, lastUsed: 11 });
    const stored = mergeDictionaries(dict({ words: [{ w: "a", lang: "en", count: 1, lastUsed: 12, deleted: true }] }), dict({ words: [{ w: "a", lang: "en", count: 9, lastUsed: 11 }] }));
    expect(stored.words[0]).toEqual({ w: "a", lang: "en", count: 9, lastUsed: 12, deleted: true });
    const both = mergeDictionaries(dict({ words: [{ w: "a", lang: "en", count: 1, lastUsed: 1, deleted: true }] }), dict({ words: [{ w: "a", lang: "en", count: 1, lastUsed: 9, deleted: true }] }));
    expect(both.words[0]!.deleted).toBe(true);
    const notDeleted = mergeDictionaries(null, dict({ words: [{ w: "a", lang: "en", count: 1, lastUsed: 1, deleted: false }] }));
    expect(notDeleted.words[0]).toEqual({ w: "a", lang: "en", count: 1, lastUsed: 1 });
  });

  it("merges bigrams by a+b+lang with the same rules", () => {
    const out = mergeDictionaries(
      dict({ bigrams: [{ a: "good", b: "morning", lang: "en", count: 7, lastUsed: 5 }, { a: "x", b: "y", lang: "en", count: 1, lastUsed: 9, deleted: true }] }),
      dict({ bigrams: [{ a: "good", b: "morning", lang: "en", count: 3, lastUsed: 8 }, { a: "x", b: "y", lang: "en", count: 2, lastUsed: 4 }, { a: "good", b: "night", lang: "en", count: 1, lastUsed: 1 }] }),
    );
    expect(out.bigrams).toEqual([
      { a: "good", b: "morning", lang: "en", count: 7, lastUsed: 8 },
      { a: "x", b: "y", lang: "en", count: 2, lastUsed: 9, deleted: true },
      { a: "good", b: "night", lang: "en", count: 1, lastUsed: 1 },
    ]);
  });
});

describe("keyboard dictionary API", () => {
  it("rejects unauthenticated and bad-token requests", async () => {
    expect((await client().call("/api/keyboard/dictionary")).status).toBe(401);
    expect((await client().call("/api/keyboard/dictionary", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await client().call("/api/keyboard/dictionary", { method: "PUT", body: dict() })).status).toBe(401);
  });

  it("PUT needs the CSRF header even with a valid bearer token", async () => {
    const token = await nativeToken();
    const res = await client().call("/api/keyboard/dictionary", { method: "PUT", body: dict(), headers: { authorization: `Bearer ${token}`, "x-talorys-request": "" } });
    expect(res.status).toBe(403);
  });

  it("GET is 404 when empty; PUT merges with the stored copy and GET returns it (native bearer)", async () => {
    await clear();
    const token = await nativeToken();
    const c = client();
    const h = { authorization: `Bearer ${token}`, origin: "" };
    expect((await c.call("/api/keyboard/dictionary", { headers: h })).status).toBe(404);

    const first = await c.call("/api/keyboard/dictionary", {
      method: "PUT",
      headers: h,
      body: dict({ words: [{ w: "שלום", lang: "he", count: 3, lastUsed: 100 }], bigrams: [{ a: "בוקר", b: "טוב", lang: "he", count: 2, lastUsed: 100 }] }),
    });
    expect(first.status).toBe(200);

    const second = await c.call("/api/keyboard/dictionary", {
      method: "PUT",
      headers: h,
      body: dict({ words: [{ w: "שלום", lang: "he", count: 1, lastUsed: 200 }, { w: "hello", lang: "en", count: 1, lastUsed: 5 }], bigrams: [{ a: "בוקר", b: "טוב", lang: "he", count: 1, lastUsed: 150, deleted: true }] }),
    });
    expect(second.status).toBe(200);
    const merged = (await second.json()) as KeyboardDictionary;
    expect(merged.words).toEqual([
      { w: "שלום", lang: "he", count: 3, lastUsed: 200 },
      { w: "hello", lang: "en", count: 1, lastUsed: 5 },
    ]);
    expect(merged.bigrams).toEqual([{ a: "בוקר", b: "טוב", lang: "he", count: 2, lastUsed: 150, deleted: true }]);
    expect(merged.updatedAt).toBeGreaterThan(1000);

    const got = await c.call("/api/keyboard/dictionary", { headers: h });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(merged);
  });

  it("works with the browser session cookie too", async () => {
    await clear();
    const c = await loggedIn();
    expect((await c.call("/api/keyboard/dictionary", { method: "PUT", body: dict({ words: [{ w: "x", lang: "en", count: 0, lastUsed: 0 }] }) })).status).toBe(200);
    expect(((await c.json("/api/keyboard/dictionary")) as KeyboardDictionary).words).toHaveLength(1);
  });

  it("validates the body", async () => {
    const c = await loggedIn();
    const bad: unknown[] = [
      { ...dict(), schema: 2 },
      { ...dict(), updatedAt: "now" },
      dict({ words: [{ w: "a".repeat(65), lang: "en", count: 1, lastUsed: 1 }] }),
      dict({ words: [{ w: "a", lang: "fr", count: 1, lastUsed: 1 }] as never }),
      dict({ words: [{ w: "a", lang: "en", count: -1, lastUsed: 1 }] }),
      dict({ words: [{ w: "a", lang: "en", count: 1.5, lastUsed: 1 }] }),
      dict({ bigrams: [{ a: "a", lang: "en", count: 1, lastUsed: 1 }] as never }),
      { schema: 1, updatedAt: 1, words: [] },
    ];
    for (const body of bad) {
      const res = await c.call("/api/keyboard/dictionary", { method: "PUT", body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const notJson = await c.call("/api/keyboard/dictionary", { method: "PUT", headers: { "content-type": "application/json" }, body: undefined });
    expect([400]).toContain(notJson.status);
  });

  it("returns 413 above the word, bigram and body caps", async () => {
    const c = await loggedIn();
    const words = Array.from({ length: KEYBOARD_MAX_WORDS + 1 }, () => 0);
    expect((await c.call("/api/keyboard/dictionary", { method: "PUT", body: { schema: 1, updatedAt: 1, words, bigrams: [] } })).status).toBe(413);
    const bigrams = Array.from({ length: KEYBOARD_MAX_BIGRAMS + 1 }, () => 0);
    expect((await c.call("/api/keyboard/dictionary", { method: "PUT", body: { schema: 1, updatedAt: 1, words: [], bigrams } })).status).toBe(413);
    const big = { schema: 1, updatedAt: 1, words: [{ w: "a", lang: "en", count: 1, lastUsed: 1 }], bigrams: [], pad: "x".repeat(KEYBOARD_MAX_BODY_BYTES) };
    const res = await c.call("/api/keyboard/dictionary", { method: "PUT", body: big });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("stores a large dictionary across several chunks and reads it back intact", async () => {
    await clear();
    const c = await loggedIn();
    const words = Array.from({ length: 30_000 }, (_, i) => ({ w: `מילה${i}😀`, lang: "he" as const, count: i, lastUsed: i }));
    const res = await c.call("/api/keyboard/dictionary", { method: "PUT", body: dict({ words }) });
    expect(res.status).toBe(200);
    const rows = await inAgent((a) => a.services.db.one<{ n: number }>(`SELECT COUNT(*) AS n FROM tal_keyboard_dictionary`)!.n);
    expect(rows).toBeGreaterThan(1);
    const got = (await c.json("/api/keyboard/dictionary")) as KeyboardDictionary;
    expect(got.words).toHaveLength(30_000);
    expect(got.words[29_999]).toEqual(words[29_999]);
  });
});
