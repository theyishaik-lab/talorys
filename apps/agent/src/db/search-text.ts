/**
 * Search text for the Hebrew-aware full-text indexes (memories and notes, schema 16).
 *
 * SQLite's unicode61 tokenizer splits on whitespace and punctuation only. For Hebrew that misses
 * almost everything a person types: words carry one-letter prefixes (ו ה ב ל מ ש כ, also combined:
 * "ובתל אביב", "שהילדה"), niqqud and cantillation marks are separate code points that break a
 * token in two, final letters (ך ם ן ף ץ) differ from their medial forms, and abbreviations carry
 * gershayim (צה"ל). Durable Object SQLite has no custom tokenizers or SQL functions, so the
 * normalization runs here, in JS, on both sides:
 *
 *  - index side: `indexText()` gives a `body` (normalized tokens) and `stems` (prefix-stripped
 *    variants of Hebrew tokens, max 2 prefix letters, stem at least 2 letters). The original token
 *    always stays in `body`, so exact words rank above stem matches (column weights in the query).
 *  - query side: `ftsQuery()` normalizes the same way, drops English and Hebrew stop words and ORs
 *    each term with its own stripped variants.
 *
 * English text is unchanged apart from lower-casing (the tokenizer already did that).
 */

/** Hebrew points and cantillation: U+0591–U+05BD, U+05BF, U+05C1–U+05C2, U+05C4–U+05C5, U+05C7. */
const HEBREW_MARKS = /[\u0591-\u05BD\u05BF\u05C1\u05C2\u05C4\u05C5\u05C7]/g;
const FINALS: Record<string, string> = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
const HEBREW_WORD = /^[\u05D0-\u05EA]+$/;
/** Letters that can open a Hebrew word as a prefix (ו ה ב ל מ ש כ). */
const PREFIX_FIRST = new Set([..."והבלמשכ"]);
/** A second prefix letter after the first (וב, וה, של, שה, כש, מה, לה, ...). ו only opens a word. */
const PREFIX_SECOND = new Set([..."הבלמשכ"]);
const MIN_STEM = 2;
const TOKEN = /[\p{L}\p{N}]+/gu;

/**
 * Lower-cases and normalizes text for matching: strips niqqud and cantillation, joins
 * abbreviations written with gershayim/geresh (צה"ל → צהל, ג'ירפה → גירפה), turns maqaf into a
 * space and final letters into their medial forms.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(HEBREW_MARKS, "")
    .normalize("NFC")
    .replace(/\u05BE/g, " ")
    .replace(/([\u05D0-\u05EA])["'\u05F3\u05F4\u2019\u201D]+(?=[\u05D0-\u05EA])/g, "$1")
    .replace(/[\u05DA\u05DD\u05DF\u05E3\u05E5]/g, (c) => FINALS[c] ?? c)
    .toLowerCase();
}

/** Normalized tokens of `text` (letters and digits, in order). */
export function searchTokens(text: string): string[] {
  return normalizeSearchText(text).match(TOKEN) ?? [];
}

/** Prefix-stripped variants of one normalized Hebrew token (not including the token itself). */
export function hebrewVariants(token: string): string[] {
  if (!HEBREW_WORD.test(token)) return [];
  const out: string[] = [];
  const chars = [...token];
  if (PREFIX_FIRST.has(chars[0]!) && chars.length - 1 >= MIN_STEM) {
    out.push(chars.slice(1).join(""));
    if (PREFIX_SECOND.has(chars[1]!) && chars.length - 2 >= MIN_STEM) out.push(chars.slice(2).join(""));
  }
  return out;
}

/** The two indexed columns for a document: normalized words, and the Hebrew prefix-stripped stems. */
export function indexText(text: string): { body: string; stems: string } {
  const tokens = searchTokens(text);
  const stems: string[] = [];
  for (const t of tokens) stems.push(...hebrewVariants(t));
  return { body: tokens.join(" "), stems: stems.join(" ") };
}

/**
 * Builds a safe FTS5 MATCH expression from free text: OR of quoted terms, at most `maxTerms`
 * source words. English words match as prefixes (as before); a Hebrew word matches itself as a
 * prefix and its prefix-stripped variants (prefix only when 3+ letters, so "תל" stays exact).
 */
export function ftsQuery(q: string, maxTerms = 8): string | null {
  const words = [...new Set(searchTokens(q).filter((t) => [...t].length >= 2 && !STOPWORDS.has(t)))].slice(0, maxTerms);
  if (words.length === 0) return null;
  const terms = new Set<string>();
  for (const w of words) {
    terms.add(`"${w}"*`);
    for (const v of hebrewVariants(w)) {
      if (STOPWORDS.has(v)) continue;
      terms.add([...v].length >= 3 ? `"${v}"*` : `"${v}"`);
    }
  }
  return [...terms].join(" OR ");
}

/**
 * The pre-16 query builder (English stop words, no normalization), kept for the legacy
 * `tal_*_fts` indexes, which remain as a fallback, and for the benchmark's "before" column.
 */
export function legacyFtsQuery(q: string, maxTerms = 8): string | null {
  const terms = (q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((t) => !ENGLISH_STOPWORDS.has(t)).slice(0, maxTerms);
  if (terms.length === 0) return null;
  return [...new Set(terms)].map((t) => `"${t}"*`).join(" OR ");
}

const ENGLISH_STOPWORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its me my of on or our please should so than that the their them then there these they this to us was we were what when where which who why will with would you your about also just like want need tell show give make get remember".split(
    " ",
  ),
);

/** Hebrew function words and request verbs; normalized below, so they compare against normalized tokens. */
const HEBREW_STOPWORDS = (
  "של את עם על אל מן זה זו זאת הזה הזאת הזו אלה אלו הוא היא המ הנ אני אנחנו אתה אתמ אתנ " +
  "שלי שלו שלה שלנו שלכמ שלהמ לי לו לה לנו לכמ להמ אותי אותו אותה אותנו בו בה בהמ " +
  "מה מי איפה מתי איכ למה כמה האמ האימ יש אינ לא כנ גמ או אבל כל רק עוד כמו אמ כי אז כבר מאוד יותר " +
  "היה הייתה היו יהיה תהיה להיות " +
  "תגיד תגידי תזכיר תזכירי תזכור זוכר זוכרת תספר תספרי תראה תראי תנ תני רוצה רוצים צריכ צריכה " +
  "בבקשה אפשר"
).split(" ").map(normalizeSearchText);

const STOPWORDS = new Set([...ENGLISH_STOPWORDS, ...HEBREW_STOPWORDS]);
