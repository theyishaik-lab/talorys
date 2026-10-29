import { Hono } from "hono";
import type { AppEnv } from "../app";
import { AppError, NotFoundError, ValidationError } from "../errors";
import {
  KEYBOARD_MAX_BIGRAMS,
  KEYBOARD_MAX_BODY_BYTES,
  KEYBOARD_MAX_WORDS,
  keyboardDictionarySchema,
  mergeDictionaries,
} from "../../keyboard/dictionary";

/**
 * Talorys Keyboard dictionary backup. Authenticated like every /api route (session cookie or the
 * native app's bearer token, plus the CSRF header on PUT), via the app-wide middleware.
 */
export const keyboardRoutes = new Hono<AppEnv>();

const tooLarge = (message: string) => new AppError("PAYLOAD_TOO_LARGE", message);

keyboardRoutes.get("/keyboard/dictionary", (c) => {
  const raw = c.env.agent.services.keyboardDictionary.readRaw();
  if (raw === null) throw new NotFoundError("No keyboard dictionary is backed up yet.");
  return c.body(raw, 200, { "content-type": "application/json; charset=utf-8" });
});

keyboardRoutes.put("/keyboard/dictionary", async (c) => {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > KEYBOARD_MAX_BODY_BYTES) throw tooLarge(`Request body is over ${KEYBOARD_MAX_BODY_BYTES} bytes.`);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength > KEYBOARD_MAX_BODY_BYTES) throw tooLarge(`Request body is over ${KEYBOARD_MAX_BODY_BYTES} bytes.`);

  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ValidationError("Request body must be valid JSON.");
  }
  // Count caps first, so an oversized list is a 413 rather than a schema error.
  const r = raw as { words?: unknown; bigrams?: unknown } | null;
  if (r && Array.isArray(r.words) && r.words.length > KEYBOARD_MAX_WORDS) throw tooLarge(`At most ${KEYBOARD_MAX_WORDS} words.`);
  if (r && Array.isArray(r.bigrams) && r.bigrams.length > KEYBOARD_MAX_BIGRAMS) throw tooLarge(`At most ${KEYBOARD_MAX_BIGRAMS} bigrams.`);

  const parsed = keyboardDictionarySchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);

  const store = c.env.agent.services.keyboardDictionary;
  const merged = mergeDictionaries(store.read(), parsed.data);
  if (merged.words.length > KEYBOARD_MAX_WORDS) throw tooLarge(`The merged dictionary would hold over ${KEYBOARD_MAX_WORDS} words.`);
  if (merged.bigrams.length > KEYBOARD_MAX_BIGRAMS) throw tooLarge(`The merged dictionary would hold over ${KEYBOARD_MAX_BIGRAMS} bigrams.`);

  const json = store.write(merged);
  return c.body(json, 200, { "content-type": "application/json; charset=utf-8" });
});
