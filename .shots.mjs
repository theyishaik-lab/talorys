import { chromium } from "playwright";
const [,, base, outdir, tag] = process.argv;
const browser = await chromium.launch();
const shots = [];
async function run(name, { width, height, scheme, path: p, lang = "he", act }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: scheme, locale: lang, isMobile: width < 800, hasTouch: width < 800 });
  const page = await ctx.newPage();
  await page.goto(`${base}${p}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  if (act) await act(page);
  await page.waitForTimeout(400);
  const file = `${outdir}/${tag}-${name}-${scheme}${width > 800 ? "-desktop" : ""}.png`;
  await page.screenshot({ path: file });
  shots.push(file);
  await ctx.close();
}
const chat = "/chat/004acdb7-8852-469a-8560-71144e4c9f7d";
const connect = "/chat/1c3dcd81-89f1-4118-9008-955dac2c053c";
for (const scheme of ["light", "dark"]) {
  const ph = { width: 390, height: 844, scheme };
  await run("home", { ...ph, path: "/chat" });
  await run("chat", { ...ph, path: chat });
  await run("connect", { ...ph, path: connect });
  await run("drawer", { ...ph, path: chat, act: async (page) => { await page.getByRole("button", { name: /תפריט|Menu/ }).first().click(); await page.waitForTimeout(400); } });
  await run("settings", { ...ph, path: "/settings" });
  await run("settings-ai", { ...ph, path: "/settings?tab=AI" });
  await run("notifications", { ...ph, path: "/chat", act: async (page) => { await page.getByRole("button", { name: /התראות|Notifications/ }).first().click(); await page.waitForTimeout(400); } });
}
for (const scheme of ["light", "dark"]) {
  const d = { width: 1280, height: 800, scheme };
  await run("home", { ...d, path: "/chat" });
  await run("chat", { ...d, path: chat });
  await run("settings", { ...d, path: "/settings" });
}
await run("tasks", { width: 390, height: 844, scheme: "light", path: "/tasks" });
await run("memory", { width: 390, height: 844, scheme: "dark", path: "/memory" });
await run("automations", { width: 390, height: 844, scheme: "light", path: "/automations" });
await run("home-en", { width: 390, height: 844, scheme: "light", path: "/chat", lang: "en-US" });
await browser.close();
console.log(shots.join("\n"));
