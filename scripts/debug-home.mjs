import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

page.on("console", (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));
page.on("requestfailed", (r) => console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
page.on("response", (r) => {
  if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`);
});

await page.goto(BASE, { waitUntil: "networkidle" });
console.log("url:", page.url());
console.log("title:", await page.title());

const button = page.getByRole("button", { name: /create a private session/i });
console.log("button count:", await button.count());
console.log("button visible:", await button.isVisible().catch((e) => e.message));

await button.click();
await page.waitForTimeout(2500);
console.log("url after click:", page.url());

console.log("--- full page text ---");
console.log((await page.locator("body").innerText()).slice(0, 1200));

await browser.close();
