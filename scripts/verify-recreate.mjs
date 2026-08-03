/**
 * Regression test for a reported bug:
 *
 *   "once session is ended i am not able to recreate another session and it
 *    says other user has disconnected."
 *
 * Updated for the Phase 1 mesh model (the host CLOSES the room; a guest joins
 * by knocking and being admitted), but guarding the same regression: after a
 * session ends, creating a new one from the terminal screen must reach a
 * fresh, working room with no stale ended/disconnected state bleeding in.
 *
 *   1. pair via knock/admit, host closes, both land on the terminal screen
 *   2. "New session" from the host's terminal screen must reach a fresh room
 *      and must NOT show any ended/disconnected text
 *   3. same from the guest's terminal screen
 *   4. the two peers pair again in the host's new room and notes work; the
 *      whole cycle runs twice in a row
 *   5. a full page reload on the terminal screen must not produce the bug,
 *      and "Back home" followed by creating a session again must work
 *
 * Any failure is captured as artifacts/screenshots/BUG-<description>.png.
 *
 *   node scripts/verify-recreate.mjs [baseUrl] [--headed]
 *
 * Selector contract: scripts/mesh-shared.mjs. Keep this file ASCII-only.
 */

import {
  ROOM_URL,
  SCREENSHOT_DIR,
  askToJoinButton,
  clickUntilUrlChanges,
  closeRoomAsHost,
  createRoomAsHost,
  describesDeliberateClose,
  ensureScreenshotDir,
  knockAndAdmit,
  launchMeshBrowser,
  makeChecker,
  nameGateField,
  newParticipant,
  openNotes,
  parseCliArgs,
  sendNote,
  shot,
  terminalOverlay,
  terminalText,
  wait,
  waitForRosterName,
} from "./mesh-shared.mjs";

const { base: BASE, headed: HEADED } = parseCliArgs();
const { check, state } = makeChecker();

// Anything from a terminal screen that must NOT appear in a fresh room.
const TERMINAL_TEXT =
  /ended the session|closed the session|session (was|has been|has already) (closed|ended)|disconnected|connection was lost|invite expired|declined|removed/i;

const browser = await launchMeshBrowser({ headed: HEADED });
let noteCounter = 0;

async function captureBug(page, description) {
  await ensureScreenshotDir();
  try {
    await shot(page, `BUG-${description}.png`);
  } catch {
    console.log(`  NOTE  could not capture BUG-${description}.png`);
  }
}

async function visibleText(page) {
  try {
    const overlay = terminalOverlay(page);
    if (await overlay.isVisible()) {
      return (await overlay.innerText()).replace(/\s+/g, " ").trim();
    }
  } catch {
    // Fall through.
  }
  try {
    return (await page.locator("body").innerText()).replace(/\s+/g, " ").trim().slice(0, 300);
  } catch {
    return "(page text unavailable)";
  }
}

/**
 * A freshly created room must be a working room: on a room URL, showing no
 * ended/disconnected text, and staying that way for a moment (the reported
 * bug was a delayed flip back into the ended state).
 */
async function expectFreshRoom(peer, label) {
  const page = peer.page;
  if (!ROOM_URL.test(page.url())) {
    await captureBug(page, `${label}-not-on-a-room-url`);
    check(`${label}: reaches a fresh room`, false, page.url());
    return false;
  }
  await wait(2500);
  const stale = await page.getByText(TERMINAL_TEXT).count();
  if (stale > 0) {
    const text = await visibleText(page);
    await captureBug(page, `${label}-shows-ended-instead-of-fresh-room`);
    check(`${label}: fresh room shows no ended/disconnected text`, false, `observed: ${text}`);
    return false;
  }
  check(`${label}: reaches a fresh room with no ended/disconnected text`, true);
  return true;
}

/**
 * Clicks "New session" on the terminal screen and verifies the fresh room.
 *
 * NOTE the terminal screen's "New session" routes to a brand-new room WITHOUT
 * the home page's one-shot creator marker, so the creator lands on their own
 * name gate (prefilled) and must submit it once; the server then seats them
 * as the first joiner, i.e. the host. This helper drives that extra step.
 */
async function newSessionFromTerminal(peer, label) {
  const button = peer.page.getByRole("button", { name: /new session/i });
  await button.waitFor({ timeout: 15_000 });
  const newUrl = await clickUntilUrlChanges(peer.page, button, { attempts: 10 });
  check(`${label}: New session navigates to a fresh room URL`, ROOM_URL.test(newUrl), newUrl);
  const ok = await expectFreshRoom(peer, label);

  // Pass the gate so the creator actually takes the host seat of their room.
  const gate = nameGateField(peer.page);
  if (await gate.isVisible().catch(() => false)) {
    await gate.fill(peer.name).catch(() => {});
    await askToJoinButton(peer.page).click({ timeout: 3000 }).catch(() => {});
  }
  await waitForRosterName(peer.page, peer.name, { timeout: 20_000 });
  return { url: newUrl, ok };
}

async function pairInto(hostPeer, guestPeer, roomUrl, label) {
  try {
    await knockAndAdmit(hostPeer, guestPeer, roomUrl);
    await waitForRosterName(hostPeer.page, guestPeer.name);
    await waitForRosterName(guestPeer.page, hostPeer.name);
    check(`${label}: both sides are seated together`, true);
  } catch (error) {
    await captureBug(hostPeer.page, `${label}-host-never-paired`);
    await captureBug(guestPeer.page, `${label}-guest-never-paired`);
    check(`${label}: both sides are seated together`, false, error.message);
    throw error;
  }

  // Notes must still work in the recreated session.
  noteCounter += 1;
  const text = `note after recreate ${noteCounter}`;
  await openNotes(hostPeer.page);
  await openNotes(guestPeer.page);
  await sendNote(hostPeer.page, text);
  await guestPeer.page.getByText(text).waitFor({ timeout: 10_000 });
  check(`${label}: notes still work`, true);
}

async function closeFromHost(hostPeer, guestPeer, label) {
  await closeRoomAsHost(hostPeer);

  const hostText = await terminalText(hostPeer.page).catch(() => null);
  check(`${label}: host lands on a terminal screen`, typeof hostText === "string", hostText ?? "none");
  const guestText = await terminalText(guestPeer.page).catch(() => null);
  check(`${label}: guest lands on a terminal screen`, typeof guestText === "string", guestText ?? "none");
  if (typeof guestText === "string" && !describesDeliberateClose(guestText)) {
    // Wording contract: a deliberate close must never read as a disconnect.
    check(`${label}: the guest is told the close was deliberate`, false, guestText.slice(0, 140));
  }
}

async function run() {
  const host = await newParticipant(browser, "HOST", { name: "Hana" });
  const guest = await newParticipant(browser, "GUEST", { name: "Greta" });

  // ------------------------------------------------------------ first pair
  console.log("\nPairing the first session");
  const firstRoom = await createRoomAsHost(host, BASE);
  await pairInto(host, guest, firstRoom, "first session");

  // --------------------------------------------- cycle 1: close and recreate
  console.log("\nCycle 1: host closes, both recreate from the terminal screen");
  await closeFromHost(host, guest, "cycle 1");

  const hostNew = await newSessionFromTerminal(host, "cycle 1 host");
  const guestNew = await newSessionFromTerminal(guest, "cycle 1 guest");
  check(
    "cycle 1: the two peers created distinct fresh rooms",
    hostNew.url !== guestNew.url,
    `${hostNew.url} vs ${guestNew.url}`,
  );

  // Pair the recreated sessions: the guest abandons its own room and joins
  // the host's new one, exactly like a user pasting the newly shared link.
  await pairInto(host, guest, hostNew.url, "cycle 1 re-pair");

  // --------------------------------------------- cycle 2: do it all again
  console.log("\nCycle 2: the whole cycle must work twice in a row");
  await closeFromHost(host, guest, "cycle 2");

  const hostNew2 = await newSessionFromTerminal(host, "cycle 2 host");
  const guestNew2 = await newSessionFromTerminal(guest, "cycle 2 guest");
  check(
    "cycle 2: the two peers created distinct fresh rooms",
    hostNew2.url !== guestNew2.url,
    `${hostNew2.url} vs ${guestNew2.url}`,
  );
  await pairInto(host, guest, hostNew2.url, "cycle 2 re-pair");

  // ------------------------------------- reload on the terminal screen
  console.log("\nReloading the terminal screen");
  await closeFromHost(host, guest, "cycle 3");

  await host.page.reload();
  // The old model tombstoned spent codes; the mesh model may instead release
  // the room entirely. Either a terminal screen or a fresh, working room is
  // acceptable after the reload -- what must NOT happen is the reported bug:
  // a wedged page or stale "disconnected" state that blocks recreating.
  const outcome = await Promise.race([
    terminalOverlay(host.page)
      .waitFor({ timeout: 20_000 })
      .then(() => "terminal")
      .catch(() => "none"),
    host.page
      .getByRole("button", { name: /create|leave|close|new session/i })
      .first()
      .waitFor({ timeout: 20_000 })
      .then(() => "working-page")
      .catch(() => "none"),
  ]);
  check(
    "reload on the terminal screen lands somewhere sane",
    outcome !== "none",
    await visibleText(host.page),
  );

  if (outcome === "terminal") {
    const afterReload = await newSessionFromTerminal(host, "post-reload host");
    check("post-reload: New session leads to a working room", afterReload.ok, afterReload.url);
  } else {
    await host.page.goto(BASE);
    await createRoomAsHost(host, BASE);
    const ok = await expectFreshRoom(host, "post-reload host via home");
    check("post-reload: creating a session still works", ok);
  }

  // ------------------------------------- Back home, then create again
  console.log('\n"Back home" from the terminal screen, then create again');
  const backHome = guest.page.getByRole("link", { name: /back home/i });
  await backHome.waitFor({ timeout: 15_000 });
  await clickUntilUrlChanges(guest.page, backHome, { attempts: 10 });
  await guest.page
    .getByRole("button", { name: /create a private session|create/i })
    .first()
    .waitFor({ timeout: 15_000 });
  check('guest: "Back home" lands on the home page', true);

  await createRoomAsHost(guest, BASE);
  const guestHomeRoom = await expectFreshRoom(guest, "guest via home");
  check("guest can create a fresh session from home after it all", guestHomeRoom);

  await Promise.all([host.context.close(), guest.context.close()]);
}

try {
  console.log(`Recreate-a-session regression checks against ${BASE}${HEADED ? " (headed)" : ""}`);
  await run();
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await browser.close().catch(() => {});
}

if (state.failures > 0) {
  console.log(`\nBUG screenshots (if any) are under ${SCREENSHOT_DIR}`);
}
console.log(
  `\n${state.failures === 0 ? "All recreate checks passed - the reported bug did NOT reproduce." : `${state.failures} check(s) failed - see FAIL lines above.`} (${state.passes} passed, ${state.failures} failed, ${state.skips} skipped)`,
);
process.exit(state.failures === 0 ? 0 : 1);
