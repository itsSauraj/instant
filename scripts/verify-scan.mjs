/**
 * Verifies the camera-scan join path by synthesising a video file that actually
 * contains a QR code and feeding it to Chromium as a fake camera. The real
 * component then decodes real frames, so this exercises the whole path rather
 * than stubbing the decoder.
 *
 *   node scripts/verify-scan.mjs [baseUrl]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const WIDTH = 640;
const HEIGHT = 480;
const FRAMES = 20;

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
};

/**
 * Renders `text` as a QR into a YUV4MPEG2 file. Y4M is a trivial container:
 * a text header, then per frame a `FRAME` marker plus planar Y, U and V.
 * Chromium loops the file for the lifetime of the fake capture device.
 */
function writeQrY4m(path, text) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const modules = qr.modules.size;
  const quiet = 4;
  const total = modules + quiet * 2;
  const scale = Math.floor((Math.min(WIDTH, HEIGHT) * 0.85) / total);
  if (scale < 2) throw new Error(`QR too dense for ${WIDTH}x${HEIGHT} (scale ${scale})`);

  const side = total * scale;
  const originX = Math.floor((WIDTH - side) / 2);
  const originY = Math.floor((HEIGHT - side) / 2);

  // Full-range luma: white ground, black modules, for maximum contrast.
  const luma = Buffer.alloc(WIDTH * HEIGHT, 255);
  for (let my = 0; my < modules; my += 1) {
    for (let mx = 0; mx < modules; mx += 1) {
      if (!qr.modules.data[my * modules + mx]) continue;
      const x0 = originX + (mx + quiet) * scale;
      const y0 = originY + (my + quiet) * scale;
      for (let y = y0; y < y0 + scale; y += 1) {
        luma.fill(0, y * WIDTH + x0, y * WIDTH + x0 + scale);
      }
    }
  }

  // Neutral chroma at 4:2:0.
  const chroma = Buffer.alloc((WIDTH / 2) * (HEIGHT / 2), 128);
  const header = Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F25:1 It A1:1 C420mpeg2\n`, "ascii");
  const marker = Buffer.from("FRAME\n", "ascii");

  const parts = [header];
  for (let i = 0; i < FRAMES; i += 1) parts.push(marker, luma, chroma, chroma);
  writeFileSync(path, Buffer.concat(parts));
  return { modules, scale };
}

async function scan(y4mPath, { expectUrl, expectRefusal }) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-video-capture=${y4mPath}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const context = await browser.newContext({ permissions: ["camera"] });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log(`  [pageerror] ${e.message}`));

  try {
    await page.goto(BASE);

    // Retry: a click can land before React attaches its handlers.
    const trigger = page.getByRole("button", { name: /scan a code with your camera/i });
    for (let i = 0; i < 20; i += 1) {
      await trigger.click({ timeout: 5000 }).catch(() => {});
      if (await page.getByRole("dialog").isVisible().catch(() => false)) break;
    }
    check("the scan dialog opens", await page.getByRole("dialog").isVisible());

    if (expectRefusal) {
      await page.getByText(/not an Instant invite/i).waitFor({ timeout: 25_000 });
      check("a foreign QR is refused rather than followed", true);
      check("it did not navigate away from the home page", new URL(page.url()).pathname === "/");
      mkdirSync("artifacts/screenshots", { recursive: true });
      writeFileSync("artifacts/screenshots/scan-refused.png", await page.screenshot());
      return;
    }

    mkdirSync("artifacts/screenshots", { recursive: true });
    // Capture the live camera preview before it navigates away.
    await page.waitForTimeout(1200);
    writeFileSync("artifacts/screenshots/scan-dialog.png", await page.screenshot());

    await page.waitForURL(/\/room\//, { timeout: 30_000 });
    check("scanning navigated into a room", true);
    check(
      "it opened the room the code encoded",
      new URL(page.url()).pathname === new URL(expectUrl).pathname,
      `got ${page.url()} expected path ${new URL(expectUrl).pathname}`,
    );
    // The property that actually matters: the scanned code named a *different*
    // origin, and we stayed on ours. Only the room id is taken from the QR.
    check(
      "it stayed on this origin rather than the one in the QR",
      new URL(page.url()).origin === new URL(BASE).origin,
      `landed on ${new URL(page.url()).origin}`,
    );

    await page.getByText(/waiting for one other person/i).waitFor({ timeout: 20_000 });
    check("the scanned room reaches a lobby", true);

    // Count live *camera* tracks specifically. The room legitimately binds its
    // own (empty) remote MediaStream to a video element, so merely counting
    // bound elements would flag that and prove nothing about the camera.
    const liveCameraTracks = await page.evaluate(() =>
      [...document.querySelectorAll("video")]
        .map((v) => v.srcObject)
        .filter((s) => s instanceof MediaStream)
        .flatMap((s) => s.getVideoTracks())
        .filter((t) => t.readyState === "live").length,
    );
    check(
      "the camera was released when the scanner closed",
      liveCameraTracks === 0,
      `${liveCameraTracks} live video track(s)`,
    );
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Captures the join card in both themes so the affordance can be reviewed. */
async function shotJoinField() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const theme of ["dark", "light"]) {
      // Reduced motion makes geometry deterministic: the app skips its GSAP
      // entrance, so measurements cannot race an in-flight transform.
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      await page.addInitScript((t) => localStorage.setItem("instant-theme", t), theme);
      await page.goto(BASE);

      const field = page.getByLabel("Invite link or session code");
      await field.waitFor({ timeout: 20_000 });
      const scanButton = page.getByRole("button", { name: /scan a code with your camera/i });
      check(`${theme}: the scan button sits inside the join field`, await scanButton.isVisible());

      // Prove it is inside the input's box rather than merely nearby.
      const inputBox = await field.boundingBox();
      const buttonBox = await scanButton.boundingBox();
      check(
        `${theme}: it is positioned within the field's bounds`,
        Boolean(
          inputBox &&
            buttonBox &&
            buttonBox.x > inputBox.x &&
            buttonBox.x + buttonBox.width <= inputBox.x + inputBox.width + 1 &&
            buttonBox.y >= inputBox.y - 1 &&
            buttonBox.y + buttonBox.height <= inputBox.y + inputBox.height + 1,
        ),
        `input=${JSON.stringify(inputBox)} button=${JSON.stringify(buttonBox)}`,
      );

      mkdirSync("artifacts/screenshots", { recursive: true });
      writeFileSync(
        `artifacts/screenshots/scan-join-field-${theme}.png`,
        await page.locator("form[data-join-form]").locator("..").screenshot(),
      );
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

const dir = join(tmpdir(), "instant-scan");
mkdirSync(dir, { recursive: true });
const validPath = join(dir, "valid.y4m");
const foreignPath = join(dir, "foreign.y4m");

console.log(`Verifying camera scan against ${BASE}`);

// A real invite URL, deliberately on a different origin than the page under
// test, because that is what scanning another device's screen looks like.
const inviteUrl = "https://instant.example.com/room/k3f9mq2t8xbv7rn0";
const shape = writeQrY4m(validPath, inviteUrl);
console.log(`  (QR ${shape.modules}x${shape.modules} modules at ${shape.scale}px)`);

console.log("\nThe join field with its scan affordance");
await shotJoinField();

console.log("\nScanning a valid invite code");
await scan(validPath, { expectUrl: inviteUrl });

// Note this is NOT a payload containing a room id: a QR that encodes a genuine
// invite link necessarily joins that session, exactly as clicking a link would.
// What must never happen is treating the scanned text as somewhere to navigate.
console.log("\nScanning a code that is not an invite at all");
writeQrY4m(foreignPath, "https://evil.example.com/phishing-page");
await scan(foreignPath, { expectRefusal: true });

console.log(failures === 0 ? "\nAll scan checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
