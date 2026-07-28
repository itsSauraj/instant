import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => {
  if (!m.text().includes("webpack-hmr")) console.log(`[console:${m.type()}] ${m.text().slice(0, 300)}`);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));
const requests = [];
page.on("response", (r) => requests.push(`${r.status()} ${r.url()}`));
page.on("requestfailed", (r) => requests.push(`FAILED ${r.url()} ${r.failure()?.errorText}`));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

const state = await page.evaluate(() => {
  const hydratedCount = [...document.querySelectorAll("*")].filter((el) =>
    Object.keys(el).some((k) => k.startsWith("__reactFiber$")),
  ).length;
  const containers = [...document.querySelectorAll("*")].filter((el) =>
    Object.keys(el).some((k) => k.startsWith("__reactContainer$")),
  );
  return {
    hydratedElementCount: hydratedCount,
    containerTags: containers.map((c) => c.tagName),
    htmlHasContainer: Object.keys(document.documentElement).some((k) =>
      k.startsWith("__reactContainer$"),
    ),
    docHasContainer: Object.keys(document).some((k) => k.startsWith("__reactContainer$")),
    nextF: typeof self.__next_f,
    nextFLen: Array.isArray(self.__next_f) ? self.__next_f.length : -1,
    scripts: [...document.scripts].map((s) => s.src || `inline(${(s.textContent ?? "").slice(0, 60)})`),
  };
});
console.log(JSON.stringify(state, null, 2));
console.log("--- responses ---");
for (const r of requests) console.log(r);

await browser.close();
