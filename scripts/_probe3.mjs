import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

// Capture errors before Next's dev overlay swallows them.
await page.addInitScript(() => {
  window.__caught = [];
  window.addEventListener("error", (e) => {
    window.__caught.push(`error: ${e.message} @ ${e.filename}:${e.lineno}`);
  }, true);
  window.addEventListener("unhandledrejection", (e) => {
    window.__caught.push(`rejection: ${e.reason?.stack ?? String(e.reason)}`);
  }, true);
  const origError = console.error.bind(console);
  console.error = (...args) => {
    window.__caught.push(`console.error: ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" ").slice(0, 600)}`);
    origError(...args);
  };
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(3000);

const caught = await page.evaluate(() => window.__caught);
console.log("--- captured errors ---");
for (const c of caught) console.log(c);

const overlay = await page.evaluate(() => {
  const portal = document.querySelector("nextjs-portal");
  if (!portal || !portal.shadowRoot) return "no portal/shadow";
  return portal.shadowRoot.textContent?.slice(0, 1500) ?? "empty";
});
console.log("--- overlay text ---");
console.log(overlay);

await browser.close();
