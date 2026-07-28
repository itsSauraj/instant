import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("[TP]") || (m.type() === "error" && !t.includes("webpack-hmr"))) console.log(t);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

await page.route("**/_next/static/chunks/**", async (route) => {
  const response = await route.fetch();
  let body = await response.text();
  if (body.includes("function preloadModule(metadata)")) {
    body = body.replace(
      "var thenable = __turbopack_load_by_url__(chunks[i]);",
      `var __url = chunks[i];
       var thenable = __turbopack_load_by_url__(__url);
       if (!self.__tpSeen) self.__tpSeen = new Set();
       if (!self.__tpSeen.has(__url)) {
         self.__tpSeen.add(__url);
         console.log('[TP] load requested: ' + __url);
         thenable.then(function(){ console.log('[TP] load resolved: ' + __url); },
                       function(e){ console.log('[TP] load rejected: ' + __url + ' -> ' + e); });
       }`,
    );
    console.log("[patched]", route.request().url().split("/").pop());
  }
  await route.fulfill({ response, body });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(5000);
await browser.close();
