// Bundle-size budget: the JS a phone has to download and parse before the chat shows must stay
// small. Runs after `vite build`; a build that busts the budget fails so it never ships by accident.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const dist = new URL("../dist/assets/", import.meta.url).pathname;
const BUDGET_KB = { initialJs: 200, css: 20, lazyChunk: 32 }; // lazyChunk: the recurrence chunk (Tasks/Automations) carries zod, ~25 KB
const INITIAL = /^(index|queries|hooks|rolldown-runtime|Markdown)-/; // chunks loaded at startup (see dist/index.html + the chat page's imports)

const gz = (f) => gzipSync(readFileSync(join(dist, f))).length / 1024;
const files = readdirSync(dist).filter((f) => statSync(join(dist, f)).isFile());
const js = files.filter((f) => f.endsWith(".js"));
const css = files.filter((f) => f.endsWith(".css"));

const initial = js.filter((f) => INITIAL.test(f));
const initialKb = initial.reduce((a, f) => a + gz(f), 0);
const cssKb = css.reduce((a, f) => a + gz(f), 0);
const lazy = js.filter((f) => !INITIAL.test(f)).map((f) => ({ f, kb: gz(f) }));
const fonts = files.filter((f) => f.endsWith(".woff2")).map((f) => ({ f, kb: statSync(join(dist, f)).size / 1024 }));

const rows = [
  `initial JS (gzip): ${initialKb.toFixed(1)} KB of ${BUDGET_KB.initialJs} KB  [${initial.map((f) => `${f.split("-")[0]} ${gz(f).toFixed(0)}`).join(", ")}]`,
  `CSS (gzip): ${cssKb.toFixed(1)} KB of ${BUDGET_KB.css} KB`,
  ...lazy.map(({ f, kb }) => `lazy ${f.split("-")[0]} (gzip): ${kb.toFixed(1)} KB of ${BUDGET_KB.lazyChunk} KB`),
  `fonts: ${fonts.map(({ f, kb }) => `${f.replace(/-[^-]+\.woff2$/, "")} ${kb.toFixed(0)} KB`).join(", ")}`,
];
console.log(`bundle budget\n  ${rows.join("\n  ")}`);

const failures = [];
if (initialKb > BUDGET_KB.initialJs) failures.push(`initial JS ${initialKb.toFixed(1)} KB > ${BUDGET_KB.initialJs} KB`);
if (cssKb > BUDGET_KB.css) failures.push(`CSS ${cssKb.toFixed(1)} KB > ${BUDGET_KB.css} KB`);
for (const { f, kb } of lazy) if (kb > BUDGET_KB.lazyChunk) failures.push(`${f} ${kb.toFixed(1)} KB > ${BUDGET_KB.lazyChunk} KB`);
if (failures.length) {
  console.error(`bundle budget exceeded:\n  ${failures.join("\n  ")}\nRaise the budget in apps/web/scripts/bundle-budget.mjs only on purpose.`);
  process.exit(1);
}
