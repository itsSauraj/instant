import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (t.startsWith("[H]") || (m.type() === "error" && !t.includes("webpack-hmr"))) console.log(t);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));

// Patch the served Next client chunk to log hydrate() progress.
await page.route("**/_next/static/chunks/**", async (route) => {
  const response = await route.fetch();
  let body = await response.text();
  if (body.includes("async function hydrate(")) {
    body = body
      .replace(
        /const initialRSCPayload = await initialServerResponse;/g,
        `console.log('[H] awaiting initialServerResponse');
         initialServerResponse.then((v)=>console.log('[H] RSC root resolved'), (e)=>console.log('[H] RSC root rejected: ' + (e && e.stack || e)));
         const initialRSCPayload = await initialServerResponse;
         console.log('[H] got initialRSCPayload');`,
      )
      .replace(
        /hydrateRoot\(appElement, reactEl, \{/g,
        `console.log('[H] calling hydrateRoot'), hydrateRoot(appElement, reactEl, {`,
      );
    console.log("[patched chunk]", route.request().url().split("/").pop());
  }
  await route.fulfill({ response, body });
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(5000);
await browser.close();
