/**
 * Shared plumbing for the Playwright verification scripts in this directory.
 *
 * Keep this file ASCII-only: a previous editing round-trip through PowerShell
 * corrupted non-ASCII characters, so none are allowed back in.
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOT_DIR = path.resolve(SCRIPTS_DIR, "..", "artifacts", "screenshots");

export const ROOM_URL = /\/room\/[0-9a-z-]+$/;

export function parseCliArgs(argv = process.argv) {
  const base = argv.slice(2).find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:3111";
  const headed = argv.includes("--headed");
  return { base, headed };
}

const MEDIA_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
export const MOBILE_VIEWPORT = { width: 390, height: 844 };
/** Small enough that two watchable windows fit side by side on a 1080p display. */
const HEADED_VIEWPORT = { width: 920, height: 720 };

/**
 * Launches the browser(s) for a two-peer run.
 *
 * Headless: a single browser hosts every context.
 * Headed: two separate browser processes with slowMo, positioned side by side
 * (window position and size are per-process Chromium args), so a human can
 * watch both peers interact without the windows stacking on top of each other.
 */
export async function launchBrowsers({ headed }) {
  if (!headed) {
    const browser = await chromium.launch({ headless: true, args: MEDIA_ARGS });
    return { left: browser, right: browser, all: [browser], viewport: DESKTOP_VIEWPORT, headed };
  }

  const slowMo = 150;
  const [left, right] = await Promise.all([
    chromium.launch({
      headless: false,
      slowMo,
      args: [...MEDIA_ARGS, "--window-position=24,40", "--window-size=944,820"],
    }),
    chromium.launch({
      headless: false,
      slowMo,
      args: [...MEDIA_ARGS, "--window-position=984,40", "--window-size=944,820"],
    }),
  ]);
  return { left, right, all: [left, right], viewport: HEADED_VIEWPORT, headed };
}

export async function closeBrowsers(browsers) {
  await Promise.all(browsers.all.map((browser) => browser.close().catch(() => {})));
}

/**
 * Each peer needs its own context so the two sides share no origin state.
 * The theme is pinned before first paint so screenshots are deterministic
 * regardless of the machine's prefers-color-scheme.
 */
export async function newPeer(browser, label, { viewport = DESKTOP_VIEWPORT, theme = "dark" } = {}) {
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
    viewport,
  });
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("instant-theme", value);
    } catch {
      // Storage disabled; the app falls back to its own default.
    }
    // The CSP (connect-src 'self') blocks fetch() on blob: URLs, so keep a
    // handle on every created blob; the integrity checks read bytes from here.
    const original = URL.createObjectURL.bind(URL);
    const registry = new Map();
    window.__blobRegistry = registry;
    URL.createObjectURL = (object) => {
      const url = original(object);
      try {
        registry.set(url, object);
      } catch {
        // Best effort only.
      }
      return url;
    };
  }, theme);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`  [${label}] page error: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    // Dev-server HMR sockets fail under 127.0.0.1; not our concern.
    if (message.type() === "error" && !text.includes("webpack-hmr")) {
      console.log(`  [${label}] console: ${text}`);
    }
  });
  return { context, page, label };
}

export const statusBadge = (page) => page.locator('[data-slot="badge"][aria-live="polite"]');

/** Tab labels collapse on small screens ("Audio & video" renders as "A/V"). */
const TAB_NAMES = {
  notes: /notes/i,
  files: /files/i,
  media: /audio & video|a\/v/i,
};
export const tab = (page, key) => page.getByRole("tab", { name: TAB_NAMES[key] ?? key });

/**
 * Clicks "Create a private session" until the URL changes. A click can land
 * after first paint but before React has attached its handlers, in which case
 * it is silently swallowed - so retry until navigation actually happens.
 */
export async function createSession(page) {
  const button = page.getByRole("button", { name: /create a private session/i });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      // A short click timeout matters under dev-server churn: Fast Refresh can
      // replace the node mid-click ("element detached"), and a default 30s
      // click would burn the whole budget on one stale handle.
      await button.click({ timeout: 2000 });
      await page.waitForURL(ROOM_URL, { timeout: 1500 });
      return page.url();
    } catch {
      if (attempt === 19) throw new Error("Create-session button never navigated");
      await wait(500);
    }
  }
  throw new Error("unreachable");
}

/**
 * Retry-click for any control that triggers a client-side navigation; the same
 * hydration race createSession works around applies to every such button.
 */
export async function clickUntilUrlChanges(page, locator, { timeout = 2000, attempts = 8 } = {}) {
  const before = page.url();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await locator.click({ timeout: 2000 });
      await page.waitForURL((url) => url.toString() !== before, { timeout });
      return page.url();
    } catch {
      if (attempt === attempts - 1) {
        throw new Error(`Click never navigated away from ${before}`);
      }
      await wait(400);
    }
  }
  throw new Error("unreachable");
}

export const isDark = (page) =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

/** Flips the theme with the real header toggle and waits for it to apply. */
export async function toggleTheme(page) {
  const before = await isDark(page);
  await page.locator('button[aria-label^="Switch to"]').first().click();
  await page.waitForFunction(
    (was) => document.documentElement.classList.contains("dark") !== was,
    before,
    { timeout: 5000 },
  );
  return !before;
}

export async function resetScreenshotDir() {
  await rm(SCREENSHOT_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
}

export async function ensureScreenshotDir() {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
}

/** Saves a viewport-sized PNG under artifacts/screenshots. */
export async function shot(page, name) {
  await ensureScreenshotDir();
  const file = path.join(SCREENSHOT_DIR, name);
  await page.screenshot({ path: file });
  console.log(`  SHOT  ${name}`);
  return file;
}

export async function listScreenshots() {
  try {
    return (await readdir(SCREENSHOT_DIR)).filter((name) => name.endsWith(".png")).sort();
  } catch {
    return [];
  }
}

export function makeChecker() {
  const state = { failures: 0, passes: 0 };
  const check = (name, condition, detail) => {
    if (condition) {
      state.passes += 1;
      console.log(`  PASS  ${name}`);
    } else {
      state.failures += 1;
      console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
    }
  };
  return { state, check };
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
