/**
 * Shared plumbing for the Phase 1 multi-peer (mesh) verification scripts.
 *
 * Keep this file ASCII-only: a previous editing round-trip through PowerShell
 * corrupted non-ASCII characters, so none are allowed back in.
 *
 * ============================ SELECTOR CONTRACT =============================
 * The mesh UI is being written concurrently (another worker owns it). Every
 * locator the Playwright mesh suites use lives HERE, in one place, so aligning
 * the tests with the shipped markup is a one-file edit. The locators below are
 * the *provisional contract* the suites assume:
 *
 *  - Display name entry: an <input> reachable via getByLabel(/name/i) or
 *    placeholder /name/i, either on the home page or on the room's join gate.
 *    As a belt-and-braces fallback the helpers pre-seed localStorage keys
 *    "instant-name" and "instant-display-name" before first paint.
 *  - Knock (joiner side): after navigating to the room URL, a joiner either
 *    knocks automatically or via a button /ask to join|knock|request|join/i.
 *    While waiting they show text /waiting for (the )?host|asked to join|
 *    waiting to be let in|approval/i.
 *  - Knock (host side): the host sees the joiner's name plus buttons
 *    /admit|allow|accept|let .*in/i and /deny|decline|reject/i.
 *  - Roster: a region [data-slot="roster"], [data-roster], or an element with
 *    aria-label containing "articipant". Rows carry the display name and
 *    markers for host (/host/i), self (/you/i) and away
 *    (/away|reconnecting|reconnect/i).
 *  - Leave (anyone): button /leave/i.
 *  - Close (host only): button /close|end/i restricted to the host.
 *  - Terminal screen: [role="alertdialog"] (same convention as the old
 *    EndedOverlay), with wording that distinguishes a deliberate close
 *    (/closed|ended/i) from a drop (/disconnected|lost/i).
 * ============================================================================
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

export const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCREENSHOT_DIR = path.resolve(SCRIPTS_DIR, "..", "artifacts", "screenshots");
export const ROOM_URL = /\/room\/[0-9a-z-]+/;

export const MEDIA_ARGS = [
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
];

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 };
export const MOBILE_VIEWPORT = { width: 390, height: 844 };

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const randomRoomId = () =>
  Array.from({ length: 8 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("");

export function parseCliArgs(argv = process.argv) {
  const base = argv.slice(2).find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:3111";
  const headed = argv.includes("--headed");
  return { base, headed };
}

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** PASS/FAIL/SKIP checker. SKIPs are always printed, never silent. */
export function makeChecker() {
  const state = { failures: 0, passes: 0, skips: 0 };
  const check = (name, condition, detail) => {
    if (condition) {
      state.passes += 1;
      console.log(`  PASS  ${name}`);
    } else {
      state.failures += 1;
      console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
    }
  };
  const skip = (name, reason) => {
    state.skips += 1;
    console.log(`  SKIP  ${name} -- ${reason}`);
  };
  return { state, check, skip };
}

export async function launchMeshBrowser({ headed = false } = {}) {
  return chromium.launch({ headless: !headed, args: MEDIA_ARGS });
}

/**
 * One context per participant so nobody shares origin state. reducedMotion is
 * on by default: geometry and screenshot assertions must not race the GSAP
 * entrance animations.
 */
export async function newParticipant(
  browser,
  label,
  { viewport = DESKTOP_VIEWPORT, theme = "dark", name } = {},
) {
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
    viewport,
    reducedMotion: "reduce",
  });
  await context.addInitScript(
    ({ themeValue, nameValue }) => {
      try {
        localStorage.setItem("instant-theme", themeValue);
        if (nameValue) {
          // Belt and braces: whichever key the concurrently-built UI reads.
          localStorage.setItem("instant-name", nameValue);
          localStorage.setItem("instant-display-name", nameValue);
        }
      } catch {
        // Storage disabled; the join gate will ask instead.
      }
      // The CSP (connect-src 'self') blocks fetch() on blob: URLs, so keep a
      // handle on every created blob; file-integrity checks read bytes here.
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
    },
    { themeValue: theme, nameValue: name ?? null },
  );
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`  [${label}] page error: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error" && !text.includes("webpack-hmr")) {
      console.log(`  [${label}] console: ${text}`);
    }
  });
  return { context, page, label, name };
}

/**
 * Retry-click: a click can land after first paint but before React has
 * attached its handlers, in which case it is swallowed. Retries until
 * `after()` resolves truthy.
 */
export async function clickUntil(locator, after, { attempts = 15, delay = 500 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await locator.click({ timeout: 2000 }).catch(() => {});
    try {
      if (await after()) return true;
    } catch {
      // Keep trying.
    }
    await wait(delay);
  }
  return false;
}

/** Clicks a control until the page URL changes (client-side navigation). */
export async function clickUntilUrlChanges(page, locator, { timeout = 2000, attempts = 10 } = {}) {
  const before = page.url();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await locator.click({ timeout: 2000 });
      await page.waitForURL((url) => url.toString() !== before, { timeout });
      return page.url();
    } catch {
      if (attempt === attempts - 1) throw new Error(`Click never navigated away from ${before}`);
      await wait(400);
    }
  }
  throw new Error("unreachable");
}

/** Fills the display-name input if the UI presents one; harmless otherwise. */
export async function fillNameIfAsked(page, name) {
  if (!name) return false;
  const candidates = [
    page.getByLabel(/your name|display name|^name$/i).first(),
    page.getByPlaceholder(/name/i).first(),
  ];
  for (const input of candidates) {
    if (!(await input.isVisible().catch(() => false))) continue;

    // Verify-and-refill rather than a single fill. The home page prefills the
    // remembered name in a post-mount effect, so a fill that lands before
    // hydration is overwritten by that effect -- and because the effect resets
    // the value, the fill's select-all no longer applies and the next attempt
    // APPENDS, producing names like "Ann ChowAnn Chow". Confirming the value
    // afterwards is the only reliable check.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await input.fill("").catch(() => {});
      await input.fill(name).catch(() => {});
      await page.waitForTimeout(150);
      if ((await input.inputValue().catch(() => "")) === name) return true;
    }
    return true;
  }
  return false;
}

/**
 * Creates a session as the HOST. Returns the room URL. The host is seated
 * immediately (no knock), per the Phase 1 contract.
 */
export async function createRoomAsHost(host, base) {
  const { page, name } = host;
  await page.goto(base);
  await fillNameIfAsked(page, name);
  const button = page.getByRole("button", { name: /create a private session|create|new session/i }).first();
  await button.waitFor({ timeout: 20_000 });
  const navigated = await clickUntil(button, async () => ROOM_URL.test(page.url()), {
    attempts: 20,
  });
  if (!navigated) throw new Error("Create-session button never navigated");
  await fillNameIfAsked(page, name);
  // The share-the-link lobby overlay covers the whole room (including the
  // header roster pill) while the host is alone; dismiss it so the room is
  // drivable. It is re-openable via the Invite button, so nothing is lost.
  const dismiss = page.getByRole("button", { name: /close and wait in the room/i }).first();
  await dismiss.waitFor({ timeout: 5000 }).catch(() => {});
  if (await dismiss.isVisible().catch(() => false)) {
    await dismiss.click({ timeout: 2000 }).catch(() => {});
  }
  return page.url();
}

// NOTE (hard-won): the admit/deny buttons in components/room/admit-queue.tsx
// set aria-label, which OVERRIDES their inner text for accessible-name
// matching. The accessible names are "Let ${name} in" and "Turn ${name}
// away"; the visible text is just "Admit"/"Deny". So
// getByRole("button", { name: /admit/i }) matches NOTHING. Always go through
// these helpers.
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The admit control for a knock. Pass `name` to answer a specific knock. */
export function admitButton(page, name) {
  const pattern = name
    ? new RegExp(`^let ${escapeRegex(name)} in$`, "i")
    : /^let .+ in$/i;
  return page.getByRole("button", { name: pattern }).first();
}

/** The deny control for a knock. Pass `name` to answer a specific knock. */
export function denyButton(page, name) {
  const pattern = name
    ? new RegExp(`^turn ${escapeRegex(name)} away$`, "i")
    : /^turn .+ away$/i;
  return page.getByRole("button", { name: pattern }).first();
}
const KNOCK_WAIT_TEXT =
  /waiting for (the )?host|asked to join|asking to be let in|waiting to be let in|been asked to let you in|approval/i;

/** The join gate's name field ("Your name") on components/room/join-gate.tsx. */
export const nameGateField = (page) => page.getByLabel(/your name/i).first();
export const askToJoinButton = (page) => page.getByRole("button", { name: /ask to join/i }).first();

/**
 * Drives the join gate: a visitor landing on an invite URL must enter a
 * non-empty name and press "Ask to join" before ANY signalling happens.
 * Resolves once the knock is pending (the waiting-approval screen).
 */
export async function joinAsGuest(page, roomUrl, name) {
  if (page.url() !== roomUrl) await page.goto(roomUrl);
  const field = nameGateField(page);
  await field.waitFor({ timeout: 20_000 });
  const ask = askToJoinButton(page);
  // Fill and click as one retried unit: a Fast Refresh between the two steps
  // resets the gate's state and the submit would be refused as empty.
  for (let attempt = 0; attempt < 15; attempt += 1) {
    if (await field.isVisible().catch(() => false)) {
      await field.fill(name).catch(() => {});
      await ask.click({ timeout: 2000 }).catch(() => {});
    }
    if (await waitingForApproval(page).isVisible().catch(() => false)) return;
    await wait(400);
  }
  throw new Error(`"Ask to join" never produced the waiting screen for ${name}`);
}

/**
 * Joins `roomUrl` as `joiner` through the name gate, then has the HOST answer
 * that specific knock by name. Resolves when the host's roster shows the
 * joiner (admit) or immediately after the click (deny).
 */
export async function knockAndAdmit(host, joiner, roomUrl, { deny = false, timeout = 30_000 } = {}) {
  await joinAsGuest(joiner.page, roomUrl, joiner.name);

  const button = deny ? denyButton(host.page, joiner.name) : admitButton(host.page, joiner.name);
  await button.waitFor({ timeout });
  await button.click();

  if (deny) return;

  // Seated: the host's roster must now include the joiner's name.
  await waitForRosterName(host.page, joiner.name, { timeout });
}

/**
 * Regions that actually PRINT participant names. The header Presence pill
 * (aria-label "Show all N participants") renders initials only, so it is
 * deliberately excluded; names live in the participants side panel.
 */
export function rosterRegion(page) {
  return page.locator(
    '[data-slot="roster"], [data-roster], ul[aria-label="Participants" i], [role="dialog"][aria-label="Participants" i]',
  );
}

const presencePill = (page) =>
  page.getByRole("button", { name: /show all \d+ participants?/i }).first();
const participantsPanel = (page) =>
  page.locator('[role="dialog"][aria-label="Participants" i]').first();
const closeParticipants = (page) =>
  page.getByRole("button", { name: /close participants/i }).first();

/**
 * Text of the participants list. If no name-bearing region is currently
 * visible, the participants side panel is opened via the header pill, read,
 * and closed again -- so callers can poll this without owning panel state.
 * Returns null when no roster is reachable at all.
 */
export async function rosterSnapshot(page) {
  const regions = rosterRegion(page);
  const texts = [];
  const count = await regions.count().catch(() => 0);
  for (let i = 0; i < count; i += 1) {
    const region = regions.nth(i);
    if (await region.isVisible().catch(() => false)) {
      const text = (await region.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (text) texts.push(text);
    }
  }
  if (texts.length > 0) return texts.join(" | ");

  // Nothing inline: open the side panel, read it, and put things back.
  const pill = presencePill(page);
  if (!(await pill.isVisible().catch(() => false))) return null;
  await pill.click({ timeout: 2000 }).catch(() => {});
  const panel = participantsPanel(page);
  try {
    await panel.waitFor({ timeout: 3000 });
  } catch {
    return null;
  }
  const text = (await panel.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  await closeParticipantsIfOpen(page);
  return text || null;
}

/**
 * Makes sure the participants side panel is closed. A lingering panel covers
 * the right of the page and swallows clicks aimed at what is underneath.
 */
export async function closeParticipantsIfOpen(page) {
  const panel = participantsPanel(page);
  if (!(await panel.isVisible().catch(() => false))) return;
  await closeParticipants(page).click({ timeout: 1500 }).catch(() => {});
  if (await panel.isVisible().catch(() => false)) {
    await page.keyboard.press("Escape").catch(() => {});
  }
  if (await panel.isVisible().catch(() => false)) {
    // The panel ships a click-anywhere-to-close scrim; use it as a last resort.
    const viewport = page.viewportSize() ?? { width: 1280, height: 800 };
    await page.mouse.click(8, Math.floor(viewport.height / 2)).catch(() => {});
  }
  await panel.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
}

export async function rosterText(page) {
  const snapshot = await rosterSnapshot(page);
  if (snapshot !== null) return snapshot;
  // Fall back to the whole page: weaker, but keeps the suite informative
  // while the roster component is still landing.
  return (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
}

export async function waitForRosterName(page, name, { timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if ((await rosterText(page)).includes(name)) return true;
    if (Date.now() > deadline) throw new Error(`roster never showed "${name}"`);
    await wait(400);
  }
}

export async function waitForRosterGone(page, name, { timeout = 30_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (!(await rosterText(page)).includes(name)) return true;
    if (Date.now() > deadline) throw new Error(`roster still shows "${name}"`);
    await wait(400);
  }
}

/** The connection badge, e.g. "Connected (2)" in a 3-person room. */
export const statusBadge = (page) => page.locator('[data-slot="badge"][aria-live="polite"]').first();

/**
 * Waits until the page reports its data channels connected. `peers` pins the
 * expected count -- the badge renders "Connected (N)" for N > 1 but a bare
 * "Connected" for a single peer, so a count is only demanded when peers > 1.
 */
export async function waitForConnected(page, { peers, timeout = 45_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = ((await statusBadge(page).innerText().catch(() => "")) ?? "").trim();
    if (/connected/i.test(text) && !/disconnected|reconnecting/i.test(text)) {
      if (peers === undefined || peers <= 1 || text.includes(`(${peers})`)) return text;
    }
    if (Date.now() > deadline) {
      throw new Error(`never reported connected${peers === undefined ? "" : ` (${peers})`}: "${text}"`);
    }
    await wait(300);
  }
}

/**
 * Waits until `links` RTCPeerConnections exist AND all report connected,
 * via the dev-only __instantPeerConnections handle. Stronger than the badge:
 * the ConnectionStatus badge currently says "Connected" from the moment the
 * seat is taken, regardless of actual link state.
 */
export async function waitForLinksConnected(page, links, { timeout = 60_000 } = {}) {
  await page.waitForFunction(
    (n) => {
      const map = window.__instantPeerConnections;
      if (!map || map.size < n) return false;
      return [...map.values()].every((pc) => pc.connectionState === "connected");
    },
    links,
    { timeout, polling: 500 },
  );
}

export const terminalOverlay = (page) => page.locator('[role="alertdialog"]').first();

/**
 * The end-reason wording contract: a deliberate close must be reported as
 * such. The correct copy may legitimately say "Everyone was disconnected"
 * in its BODY, so only the disconnect-flavoured TITLES count as wrong.
 */
export function describesDeliberateClose(text) {
  return (
    /host (ended|closed)|ended the session|closed the session/i.test(text) &&
    !/connection was lost|(person|peer|host) disconnected|lost the connection/i.test(text)
  );
}

/** A clean, deliberate close must not surface a transport/channel error. */
export function containsSpuriousError(text) {
  return /reported an error|transport error|connection error|negotiation failed/i.test(text);
}

export async function terminalText(page, { timeout = 25_000 } = {}) {
  const overlay = terminalOverlay(page);
  await overlay.waitFor({ timeout });
  return (await overlay.innerText()).replace(/\s+/g, " ").trim();
}

/** The joiner-side waiting state, before the host has answered the knock. */
export const waitingForApproval = (page) => page.getByText(KNOCK_WAIT_TEXT).first();

export const leaveButton = (page) => page.getByRole("button", { name: /leave/i }).first();

/**
 * Drives the host's deliberate close: Settings tab -> "Close session for
 * everyone" -> the confirmation dialog's "Close for everyone".
 */
export async function closeRoomAsHost(host, { timeout = 20_000 } = {}) {
  await closeParticipantsIfOpen(host.page);
  const trigger = closeButton(host.page);
  if (!(await trigger.isVisible().catch(() => false))) await openSettings(host.page);
  await trigger.waitFor({ timeout });
  await trigger.click({ timeout: 10_000 });
  const confirm = host.page
    .getByRole("button", { name: /close for everyone|end for everyone|^confirm$|^yes$/i })
    .last();
  await confirm.waitFor({ timeout: 5000 }).catch(() => {});
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click().catch(() => {});
  }
}

/** Activates a rail tab and verifies it actually took (a single click can be
 * swallowed mid-hydration or land on an animating node). */
export async function activateTab(page, namePattern) {
  const tab = page.getByRole("tab", { name: namePattern }).first();
  if (!(await tab.isVisible().catch(() => false))) return false;
  return clickUntil(tab, async () => (await tab.getAttribute("aria-selected")) === "true", {
    attempts: 10,
    delay: 300,
  });
}

/** Opens the Settings rail tab, where the host controls live. */
export async function openSettings(page) {
  return activateTab(page, /settings/i);
}

/**
 * Raises the room capacity through the host panel's stepper until the
 * displayed limit reaches `target`. The stepper lives in the Settings tab;
 * the display reads "N of 7" and only moves once the server ratifies the
 * change, so this waits between clicks.
 */
export async function ensureCapacity(host, target, { timeout = 25_000 } = {}) {
  const group = host.page.locator('[role="group"][aria-label="Participant limit" i]').first();
  await closeParticipantsIfOpen(host.page);
  const read = async () => {
    const text = (await group.innerText().catch(() => "")).replace(/\s+/g, " ");
    const match = /(\d+)\s*of\s*\d+/.exec(text);
    return match ? Number(match[1]) : null;
  };
  const raise = host.page.getByRole("button", { name: /raise the participant limit/i }).first();
  const deadline = Date.now() + timeout;
  for (;;) {
    const current = await read();
    if (current !== null && current >= target) return current;
    if (Date.now() > deadline) {
      throw new Error(`capacity display never reached ${target} (currently ${current})`);
    }
    // The stepper lives in the Settings tab; keep steering back to it, since
    // innerText reads through a hidden panel but clicks need it active.
    if (!(await raise.isVisible().catch(() => false))) {
      await openSettings(host.page);
    }
    await raise.click({ timeout: 2000 }).catch(() => {});
    await wait(400);
  }
}
export const closeButton = (page) =>
  page.getByRole("button", { name: /close (the )?(session|room)|end (the )?session( for everyone)?|end for everyone/i }).first();

/** Notes helpers (labels carried over from the existing panels). */
export async function openNotes(page) {
  await closeParticipantsIfOpen(page);
  await activateTab(page, /notes/i);
}

export async function sendNote(page, text) {
  await closeParticipantsIfOpen(page);
  const input = page.getByLabel("Note", { exact: true });
  await input.fill(text);
  await input.press("Enter");
}

export async function resetScreenshotDir() {
  await rm(SCREENSHOT_DIR, { recursive: true, force: true });
  await mkdir(SCREENSHOT_DIR, { recursive: true });
}

export async function ensureScreenshotDir() {
  await mkdir(SCREENSHOT_DIR, { recursive: true });
}

export async function shot(page, fileName) {
  await ensureScreenshotDir();
  const file = path.join(SCREENSHOT_DIR, fileName);
  await page.screenshot({ path: file });
  console.log(`  SHOT  ${fileName}`);
  return file;
}

export async function listScreenshots() {
  try {
    return (await readdir(SCREENSHOT_DIR)).filter((name) => name.endsWith(".png")).sort();
  } catch {
    return [];
  }
}
