/**
 * Verifies the home page: the animated mesh visual, the feature grid, and -
 * above all - the selector contract every Playwright suite drives the page
 * through. Keep this file ASCII-only (see the note in mesh-shared.mjs).
 *
 *   node scripts/verify-home.mjs [baseUrl]
 *
 * Geometry and theme checks run under reducedMotion: "reduce" so they cannot
 * race the GSAP entrance; the does-it-actually-move check runs in a separate
 * normal-motion context.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright";

import {
  createRoomAsHost,
  DESKTOP_VIEWPORT,
  ensureScreenshotDir,
  launchMeshBrowser,
  makeChecker,
  newParticipant,
  parseCliArgs,
  ROOM_URL,
  SCREENSHOT_DIR,
  wait,
} from "./mesh-shared.mjs";

const { base } = parseCliArgs();
const { state, check, skip } = makeChecker();

const PACKET_KINDS = ["file", "chat", "audio", "video"];

async function fullPageShot(page, fileName) {
  await ensureScreenshotDir();
  writeFileSync(path.join(SCREENSHOT_DIR, fileName), await page.screenshot({ fullPage: true }));
  console.log(`  SHOT  ${fileName}`);
}

async function elementShot(locator, fileName) {
  await ensureScreenshotDir();
  writeFileSync(path.join(SCREENSHOT_DIR, fileName), await locator.screenshot());
  console.log(`  SHOT  ${fileName}`);
}

/** Bounding boxes of all four packets, keyed by kind. */
async function samplePackets(page) {
  const boxes = {};
  for (const kind of PACKET_KINDS) {
    boxes[kind] = await page.locator(`[data-mesh-packet="${kind}"]`).boundingBox();
  }
  return boxes;
}

const moved = (a, b, threshold) =>
  Boolean(a && b) && (Math.abs(a.x - b.x) > threshold || Math.abs(a.y - b.y) > threshold);

/** The static diagram plus the feature grid, per theme, under reduced motion. */
async function checkStatic(browser, theme) {
  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.addInitScript((t) => localStorage.setItem("instant-theme", t), theme);
  await page.goto(base);

  const svg = page.locator("[data-mesh-visual]");
  // Generous: the first hit after an edit compiles the route in dev.
  await svg.waitFor({ timeout: 60_000 });
  check(`${theme}: the mesh visual renders`, await svg.isVisible());

  const nodes = await page.locator("[data-mesh-visual] [data-mesh-node]").count();
  check(`${theme}: it has exactly 5 nodes`, nodes === 5, `found ${nodes}`);

  const edges = await page.locator("[data-mesh-visual] [data-mesh-edge]").count();
  check(`${theme}: all 10 mesh edges are drawn`, edges === 10, `found ${edges}`);

  const packets = await page.locator("[data-mesh-visual] [data-mesh-packet]").count();
  check(`${theme}: all 4 payload packets exist`, packets === 4, `found ${packets}`);

  // Reduced motion must mean fully visible AND perfectly still.
  const before = await samplePackets(page);
  const allVisible = PACKET_KINDS.every((kind) => before[kind] && before[kind].width > 0);
  check(`${theme}: reduced motion shows every packet in place`, allVisible);
  await wait(700);
  const after = await samplePackets(page);
  const stillKinds = PACKET_KINDS.filter((kind) => !moved(before[kind], after[kind], 0.5));
  check(
    `${theme}: reduced motion means nothing moves`,
    stillKinds.length === PACKET_KINDS.length,
    `moved: ${PACKET_KINDS.filter((k) => !stillKinds.includes(k)).join(", ")}`,
  );

  // The feature grid, its emphasized direct-save card, and the guide link.
  const grid = page.locator("[data-feature-grid]");
  check(`${theme}: the feature grid renders`, await grid.isVisible());
  const saveCard = page.locator("[data-feature-save]");
  const saveText = ((await saveCard.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  check(
    `${theme}: the direct-save card is present and says so`,
    /saves straight to your device/i.test(saveText) && /folder/i.test(saveText),
    saveText.slice(0, 80),
  );
  const guideLink = page.locator('[data-feature-grid] a[href="/guide"]');
  check(
    `${theme}: the grid links to /guide`,
    (await guideLink.count()) > 0 &&
      /read the guide/i.test((await guideLink.first().innerText()) ?? ""),
  );

  await fullPageShot(page, `home-${theme}.png`);
  await elementShot(svg, `home-mesh-${theme}.png`);
  await context.close();
}

/** Under normal motion at least one packet must genuinely travel. */
async function checkMotionAndErrors(browser) {
  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    const text = message.text();
    // HMR chatter and the favicon probe are dev-server noise, not app bugs.
    if (message.type() === "error" && !/webpack-hmr|favicon/i.test(text)) {
      consoleErrors.push(text);
    }
  });

  await page.goto(base);
  await page.locator("[data-mesh-visual]").waitFor({ timeout: 60_000 });
  // Let hydration finish and the packet timelines leave their initial delay.
  await wait(1200);

  const t0 = await samplePackets(page);
  await wait(700);
  const t1 = await samplePackets(page);
  await wait(700);
  const t2 = await samplePackets(page);
  const movers = PACKET_KINDS.filter(
    (kind) => moved(t0[kind], t1[kind], 2) || moved(t1[kind], t2[kind], 2),
  );
  check(
    "normal motion: at least one packet actually travels",
    movers.length > 0,
    `no packet moved across two 700ms windows`,
  );
  if (movers.length > 0) console.log(`  (moving: ${movers.join(", ")})`);

  check("no page errors on the home page", pageErrors.length === 0, pageErrors.join(" | "));
  check(
    "no console errors on the home page",
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(" | "),
  );

  // The guide link navigates. The guide page is owned by another lane and may
  // still be landing, so only the URL is asserted - not that page's content.
  const guideLink = page.locator('[data-feature-grid] a[href="/guide"]').first();
  await guideLink.scrollIntoViewIfNeeded();
  await guideLink.click();
  await page
    .waitForURL((url) => new URL(url).pathname === "/guide", { timeout: 20_000 })
    .catch(() => {});
  check(
    "clicking Read the guide lands on /guide",
    new URL(page.url()).pathname === "/guide",
    `landed on ${page.url()}`,
  );

  await context.close();
}

/** The exact affordances every suite in scripts/ drives the home page with. */
async function checkSelectorContract(browser) {
  const context = await browser.newContext({
    viewport: DESKTOP_VIEWPORT,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(base);

  const create = page.getByRole("button", { name: "Create a private session", exact: true });
  await create.waitFor({ timeout: 30_000 }).catch(() => {});
  check('button "Create a private session" (exact) exists', await create.isVisible());

  check('the "Your name" field exists', await page.getByLabel("Your name").isVisible());
  check(
    'the "Invite link or session code" input exists',
    await page.getByLabel("Invite link or session code").isVisible(),
  );
  const scan = page.getByRole("button", { name: "Scan a code with your camera" });
  check("the scan button sits in the join field", await scan.isVisible());
  await context.close();
}

/** The real create flow, via the same helper every mesh suite uses. */
async function checkCreateFlow() {
  const browser = await launchMeshBrowser();
  try {
    const host = await newParticipant(browser, "host", { name: "Home Verifier" });
    const roomUrl = await createRoomAsHost(host, base);
    check(
      "createRoomAsHost still lands in a room",
      ROOM_URL.test(roomUrl),
      `ended at ${roomUrl}`,
    );
    await host.context.close();
  } catch (error) {
    check("createRoomAsHost still lands in a room", false, error.message);
  } finally {
    await browser.close();
  }
}

console.log(`Verifying the home page against ${base}`);

const probe = await fetch(base).catch(() => null);
if (!probe || !probe.ok) {
  skip("everything", `${base} is not serving (start: npx next dev --port 3111)`);
  console.log("\n1 skip; nothing verified.");
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
try {
  console.log("\nThe static diagram and feature grid, per theme (reduced motion)");
  await checkStatic(browser, "dark");
  await checkStatic(browser, "light");

  console.log("\nMotion, errors and the guide link (normal motion)");
  await checkMotionAndErrors(browser);

  console.log("\nThe selector contract");
  await checkSelectorContract(browser);
} finally {
  await browser.close();
}

console.log("\nThe real create flow (mesh-shared helpers)");
await checkCreateFlow();

console.log(
  `\n${state.passes} passed, ${state.failures} failed, ${state.skips} skipped.`,
);
process.exit(state.failures === 0 ? 0 : 1);
