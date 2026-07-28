import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
page.on("console", (m) => {
  if (!m.text().includes("webpack-hmr")) console.log(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => console.log(`[pageerror] ${e.stack ?? e.message}`));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

const info = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll("button")];
  const target = buttons.find((b) => b.textContent.includes("Create a private session"));
  if (!target) return { found: false };
  const keys = Object.keys(target);
  const propsKey = keys.find((k) => k.startsWith("__reactProps$"));
  const fiberKey = keys.find((k) => k.startsWith("__reactFiber$"));
  const props = propsKey ? target[propsKey] : null;
  const panel = target.closest("[data-anim]");
  return {
    found: true,
    reactPropsKey: propsKey ?? null,
    reactFiberKey: fiberKey ?? null,
    hasOnClick: Boolean(props && props.onClick),
    buttonOpacity: getComputedStyle(target).opacity,
    panelOpacity: panel ? getComputedStyle(panel).opacity : "no-panel",
    panelPointerEvents: panel ? getComputedStyle(panel).pointerEvents : "no-panel",
    disabled: target.disabled,
    coveredBy: (() => {
      const r = target.getBoundingClientRect();
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return el ? `${el.tagName}.${el.className}`.slice(0, 120) : "none";
    })(),
  };
});
console.log(JSON.stringify(info, null, 2));

// Try a programmatic in-page click and report URL.
await page.evaluate(() => {
  const target = [...document.querySelectorAll("button")].find((b) =>
    b.textContent.includes("Create a private session"),
  );
  target?.click();
});
await page.waitForTimeout(2000);
console.log("url after in-page click:", page.url());

await browser.close();
