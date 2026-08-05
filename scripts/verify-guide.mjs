/**
 * Verifies the /guide manual page.
 *
 *   node scripts/verify-guide.mjs [baseUrl]
 *
 * What it proves, against the live app:
 *  - /guide renders with every section anchor present, in both themes
 *    (screenshots land in artifacts/screenshots/)
 *  - the table of contents links actually scroll to their sections
 *  - the encryption section names the 10-emoji comparison and the shield
 *  - the site nav on the home page links to /guide
 *  - no console or page errors on either page
 *  - the entrance animation reveals every marked element under real motion
 *
 * All geometry assertions run with reducedMotion emulated, so GSAP cannot
 * race a measurement; the one animation check uses its own normal-motion
 * context. ASCII only, deliberately.
 */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://127.0.0.1:3111";
const SHOT_DIR = path.join(ROOT, "artifacts", "screenshots");

/** Must mirror components/guide/sections.ts (the TOC/page single source). */
const SECTION_IDS = [
  "create",
  "invite",
  "joining",
  "reload",
  "notes",
  "files",
  "calls",
  "host",
  "encryption",
  "troubleshooting",
];

let failures = 0;
let skips = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
function skip(name, why) {
  skips += 1;
  console.log(`  SKIP  ${name}${why ? ` -- ${why}` : ""}`);
}

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    try {
      localStorage.setItem("instant-theme", t);
    } catch {}
  }, theme);
}

/** Console/page error collector, filtered to genuine failures. */
function watchErrors(page, bucket) {
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    bucket.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => {
    bucket.push(`pageerror: ${error.message}`);
  });
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });

  // ------------------------------------------------------------ /guide page
  console.log("\n1. /guide renders with every section anchor, both themes");

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "reduce",
  });
  const guideErrors = [];
  const page = await context.newPage();
  watchErrors(page, guideErrors);

  const response = await page.goto(`${BASE}/guide`, { waitUntil: "domcontentloaded" });
  check("GET /guide responds 200", response?.status() === 200, `status=${response?.status()}`);

  await page.waitForSelector("main h1", { timeout: 15_000 });
  check(
    "the page title names the guide",
    /guide/i.test(await page.title()),
    `title=${JSON.stringify(await page.title())}`,
  );

  for (const id of SECTION_IDS) {
    const count = await page.locator(`section#${id}`).count();
    check(`section anchor #${id} is present`, count === 1, `count=${count}`);
  }

  const headings = await page.locator("main section h2").count();
  check(
    `every section carries a heading (${SECTION_IDS.length})`,
    headings === SECTION_IDS.length,
    `found=${headings}`,
  );

  // Both themes: reveal everything first (reducedMotion forces opacity 1 via
  // the global CSS), then screenshot the full page.
  for (const theme of ["light", "dark"]) {
    await setTheme(page, theme);
    await page.waitForTimeout(150);
    const anchorsVisible = await page.evaluate((ids) => {
      return ids.every((id) => {
        const el = document.getElementById(id);
        return Boolean(el) && getComputedStyle(el).display !== "none";
      });
    }, SECTION_IDS);
    check(`all sections render in the ${theme} theme`, anchorsVisible);
    const file = path.join(SHOT_DIR, `guide-${theme}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`  (screenshot: ${path.relative(ROOT, file)})`);
  }
  await setTheme(page, "light");

  // Under reduced motion, no marked element may be stuck invisible.
  const hidden = await page.evaluate(() => {
    return [...document.querySelectorAll('[data-anim="in"]')].filter(
      (el) => Number(getComputedStyle(el).opacity) < 0.99,
    ).length;
  });
  check("reduced motion leaves no [data-anim] element hidden", hidden === 0, `hidden=${hidden}`);

  // ------------------------------------------------------ table of contents
  console.log("\n2. The table of contents scrolls to its sections");

  const tocLinks = await page.locator('nav[data-slot="guide-toc"] a').count();
  check(
    `the sticky TOC lists all ${SECTION_IDS.length} sections`,
    tocLinks === SECTION_IDS.length,
    `links=${tocLinks}`,
  );
  const chipLinks = await page.locator('nav[data-slot="guide-toc-chips"] a').count();
  check(
    `the mobile TOC lists all ${SECTION_IDS.length} sections`,
    chipLinks === SECTION_IDS.length,
    `links=${chipLinks}`,
  );

  for (const id of SECTION_IDS) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click(`nav[data-slot="guide-toc"] a[href="#${id}"]`);
    // Anchor jumps are instant; poll only to absorb layout settling.
    const landed = await page
      .waitForFunction(
        (sectionId) => {
          const el = document.getElementById(sectionId);
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const atBottom =
            window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
          // scroll-mt-24 (6rem) should park the heading near the top; the
          // last sections can not scroll that far and stop at page bottom.
          return (rect.top >= -1 && rect.top <= 260) || (atBottom && rect.top < window.innerHeight);
        },
        id,
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    const hash = await page.evaluate(() => location.hash);
    check(
      `TOC link #${id} scrolls its section into view`,
      landed && hash === `#${id}`,
      `landed=${landed} hash=${hash}`,
    );
  }

  // ------------------------------------------------------ encryption claims
  console.log("\n3. The encryption section says what it must");

  const encryptionText = await page.locator("section#encryption").innerText();
  check(
    "names the 10-emoji comparison",
    /10 emojis/i.test(encryptionText),
    "expected the literal phrase '10 emojis'",
  );
  check("names the shield that fills as peers verify", /shield/i.test(encryptionText));
  check("names the SHA-256 pair digest", /SHA-256/.test(encryptionText));
  check("names DTLS and DTLS-SRTP transit encryption", /DTLS-SRTP/.test(encryptionText));
  check(
    "states that a rebuilt connection means verifying again",
    /fresh certificate/i.test(encryptionText),
  );
  check(
    "admits the invite link is a credential",
    /link is a credential/i.test(encryptionText),
  );

  const exampleEmojis = await page
    .locator('section#encryption [data-slot="emoji-fingerprint-example"] [role="img"] > span')
    .count();
  check(
    "shows a worked 10-emoji fingerprint example",
    exampleEmojis === 10,
    `emojis=${exampleEmojis}`,
  );

  const meshDiagram = await page.locator('[data-slot="diagram-mesh"] svg').count();
  const pathDiagram = await page.locator('[data-slot="diagram-direct-path"] svg').count();
  check("renders the mesh and direct-path diagrams", meshDiagram === 1 && pathDiagram === 1);

  // ------------------------------------------------------------- home nav
  console.log("\n4. The home page nav links to /guide");

  const homeErrors = [];
  const home = await context.newPage();
  watchErrors(home, homeErrors);
  const homeResponse = await home.goto(`${BASE}/`, { waitUntil: "domcontentloaded" });
  check("GET / responds 200", homeResponse?.status() === 200, `status=${homeResponse?.status()}`);
  const guideLink = home.locator('nav[aria-label="Site"] a[href="/guide"]');
  check("the site nav carries a Guide link", (await guideLink.count()) === 1);
  check(
    "the link is labelled Guide and visible",
    (await guideLink.count()) === 1 &&
      (await guideLink.innerText()).trim() === "Guide" &&
      (await guideLink.isVisible()),
  );
  await home.close();

  // -------------------------------------------------------------- animation
  console.log("\n5. Entrance animation under real motion");

  const motionContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    reducedMotion: "no-preference",
  });
  const motionPage = await motionContext.newPage();
  await motionPage.goto(`${BASE}/guide`, { waitUntil: "domcontentloaded" });
  await motionPage.waitForSelector("main h1", { timeout: 15_000 });

  const heroRevealed = await motionPage
    .waitForFunction(
      () => {
        const el = document.querySelector('main h1[data-anim="in"], main h1');
        return el && Number(getComputedStyle(el).opacity) > 0.99;
      },
      undefined,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  check("the header reveals on load", heroRevealed);

  // Walk the page so the IntersectionObserver sees every section, then insist
  // nothing marked for animation is left invisible.
  await motionPage.evaluate(async () => {
    const step = Math.floor(window.innerHeight * 0.7);
    for (let y = 0; y <= document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  });
  const allRevealed = await motionPage
    .waitForFunction(
      () =>
        [...document.querySelectorAll('[data-anim="in"]')].every(
          (el) => Number(getComputedStyle(el).opacity) > 0.99,
        ),
      undefined,
      { timeout: 10_000 },
    )
    .then(() => true)
    .catch(() => false);
  check("scrolling reveals every [data-anim] element", allRevealed);
  await motionContext.close();

  // ------------------------------------------------------------ error sweep
  console.log("\n6. No console or page errors");

  // Next dev overlays HMR chatter when another lane touches shared files;
  // those are not this page's errors, so only genuinely page-scoped failures
  // count. Nothing is filtered silently: everything found is printed.
  for (const [label, bucket] of [
    ["/guide", guideErrors],
    ["/ (home)", homeErrors],
  ]) {
    if (bucket.length > 0) {
      for (const entry of bucket) console.log(`        ${entry}`);
    }
    check(`${label} logged no errors`, bucket.length === 0, `${bucket.length} error(s)`);
  }

  await context.close();
  await browser.close();
}

try {
  await main();
} catch (error) {
  failures += 1;
  console.error(`  FAIL  unexpected: ${error?.message ?? error}`);
}

console.log(
  failures === 0
    ? `\nAll guide checks passed.${skips ? ` (${skips} skipped)` : ""}`
    : `\n${failures} check(s) failed.${skips ? ` (${skips} skipped)` : ""}`,
);
process.exit(failures === 0 ? 0 : 1);
