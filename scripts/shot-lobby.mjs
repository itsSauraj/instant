/**
 * Screenshots the lobby (and decodes its QR) so the invite screen can be
 * eyeballed and verified in one shot.
 *
 *   node scripts/shot-lobby.mjs [baseUrl]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import jsQR from "jsqr";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const OUT = "artifacts/screenshots";
mkdirSync(OUT, { recursive: true });

/** Mirrors lib/ids.ts: 8 chars from a Crockford-style alphabet. */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const randomRoomId = () =>
  Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("");

const browser = await chromium.launch({ headless: true });
let failures = 0;

const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
};

for (const theme of ["dark", "light"]) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  await page.addInitScript((value) => {
    localStorage.setItem("instant-theme", value);
  }, theme);

  // Navigate straight to a room rather than clicking through the home page:
  // under a dev server that is still recompiling, Fast Refresh detaches the
  // button mid-click and the race is not what this script is testing.
  const roomUrl = `${BASE}/room/${randomRoomId()}`;
  await page.goto(roomUrl);

  await page.getByText(/waiting for one other person/i).waitFor({ timeout: 20_000 });

  const qr = page.locator('[role="img"][aria-label*="QR code"]');
  await qr.waitFor({ timeout: 15_000 });
  check(`${theme}: QR wrapper is present`, await qr.isVisible());

  const canvas = qr.locator("canvas");
  const box = await canvas.boundingBox();
  check(`${theme}: canvas has real size`, Boolean(box && box.width > 40 && box.height > 40), JSON.stringify(box));

  // Decode straight from the rendered pixels - the only proof that matters.
  const pixels = await canvas.evaluate((el) => {
    const ctx = el.getContext("2d");
    const data = ctx.getImageData(0, 0, el.width, el.height);
    return { width: data.width, height: data.height, data: Array.from(data.data) };
  });
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
  check(
    `${theme}: QR decodes to the invite URL`,
    decoded?.data === roomUrl,
    `decoded=${decoded?.data ?? "null"} expected=${roomUrl}`,
  );

  writeFileSync(`${OUT}/lobby-${theme}.png`, await page.screenshot());
  writeFileSync(`${OUT}/lobby-${theme}-panel.png`, await page.locator(".panel").first().screenshot());

  await context.close();
}

await browser.close();
console.log(failures === 0 ? "\nLobby QR verified." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
