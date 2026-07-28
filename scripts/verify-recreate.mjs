/**
 * Regression test for a reported bug:
 *
 *   "once session is ended i am not able to recreate another session and it
 *    says other user has disconnected."
 *
 * Drives the full recreate flow from both peers' terminal screens:
 *   1. pair, host ends, both land on the terminal screen
 *   2. "New session" from the host's terminal screen must reach a fresh lobby
 *      and must NOT show any ended/disconnected text
 *   3. same from the guest's terminal screen
 *   4. the two brand-new sessions pair up again and notes work; the whole
 *      cycle runs twice in a row
 *   5. a full page reload on the terminal screen, and "Back home" followed by
 *      creating a session again
 *
 * Any failure is captured as artifacts/screenshots/BUG-<description>.png.
 *
 *   node scripts/verify-recreate.mjs [baseUrl] [--headed]
 *
 * Keep this file ASCII-only.
 */

import {
  ROOM_URL,
  SCREENSHOT_DIR,
  clickUntilUrlChanges,
  closeBrowsers,
  createSession,
  ensureScreenshotDir,
  launchBrowsers,
  makeChecker,
  newPeer,
  shot,
  statusBadge,
  wait,
  parseCliArgs,
} from "./e2e-shared.mjs";

const { base: BASE, headed: HEADED } = parseCliArgs();
const { check, state } = makeChecker();

const LOBBY_TEXT = /waiting for one other person/i;
// Anything from the terminal screen that must NOT appear in a fresh lobby.
const TERMINAL_TEXT =
  /other person ended the session|other person disconnected|you ended the session|session has already ended|session was closed|connection was lost|invite expired/i;

const browsers = await launchBrowsers({ headed: HEADED });
const peerOptions = { viewport: browsers.viewport };

let noteCounter = 0;

async function captureBug(page, description) {
  await ensureScreenshotDir();
  const name = `BUG-${description}.png`;
  try {
    await shot(page, name);
  } catch {
    console.log(`  NOTE  could not capture ${name}`);
  }
}

async function visibleTerminalText(page) {
  try {
    const overlay = page.locator('[role="alertdialog"]');
    if (await overlay.first().isVisible()) {
      return (await overlay.first().innerText()).replace(/\s+/g, " ").trim();
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
 * After a navigation that should land in a fresh lobby, watch for whichever
 * comes first: the lobby, or any terminal/ended text (the reported bug).
 */
async function expectFreshLobby(peer, label) {
  const page = peer.page;
  const outcome = await Promise.race([
    page
      .getByText(LOBBY_TEXT)
      .first()
      .waitFor({ timeout: 25_000 })
      .then(() => "lobby")
      .catch(() => "no-lobby"),
    page
      .getByText(TERMINAL_TEXT)
      .first()
      .waitFor({ timeout: 25_000 })
      .then(() => "terminal")
      .catch(() => "no-terminal"),
  ]);

  if (outcome === "lobby") {
    // Guard against a delayed flip back to the ended state.
    await wait(2000);
    const lateTerminal = await page.getByText(TERMINAL_TEXT).count();
    if (lateTerminal > 0) {
      const text = await visibleTerminalText(page);
      await captureBug(page, `${label}-lobby-then-flipped-to-ended`);
      check(`${label}: fresh lobby stays a lobby`, false, `flipped to: ${text}`);
      return false;
    }
    check(`${label}: reaches a fresh lobby with no ended/disconnected text`, true);
    return true;
  }

  const text = await visibleTerminalText(page);
  await captureBug(page, `${label}-shows-ended-instead-of-lobby`);
  check(
    `${label}: reaches a fresh lobby with no ended/disconnected text`,
    false,
    `observed: ${text}`,
  );
  return false;
}

/** Clicks "New session" on the terminal screen and verifies the fresh lobby. */
async function newSessionFromTerminal(peer, label) {
  const button = peer.page.getByRole("button", { name: /new session/i });
  await button.waitFor({ timeout: 15_000 });
  const newUrl = await clickUntilUrlChanges(peer.page, button, { attempts: 10 });
  check(`${label}: New session navigates to a fresh room URL`, ROOM_URL.test(newUrl), newUrl);
  const ok = await expectFreshLobby(peer, label);
  return { url: newUrl, ok };
}

async function pairInto(hostPeer, guestPeer, roomUrl, label) {
  await guestPeer.page.goto(roomUrl);
  try {
    await statusBadge(hostPeer.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
    await statusBadge(guestPeer.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
    check(`${label}: both sides report Peer connected`, true);
  } catch (error) {
    await captureBug(hostPeer.page, `${label}-host-never-connected`);
    await captureBug(guestPeer.page, `${label}-guest-never-connected`);
    check(`${label}: both sides report Peer connected`, false, error.message);
    throw error;
  }

  // Notes must still work in the recreated session.
  noteCounter += 1;
  const text = `note after recreate ${noteCounter}`;
  await hostPeer.page.getByLabel("Note", { exact: true }).fill(text);
  await hostPeer.page.getByLabel("Note", { exact: true }).press("Enter");
  await guestPeer.page.getByText(text).waitFor({ timeout: 10_000 });
  check(`${label}: notes still work`, true);
}

async function endFromHost(hostPeer, guestPeer, label) {
  await hostPeer.page.getByRole("button", { name: /end session/i }).click();
  await hostPeer.page.getByText(/you ended the session/i).waitFor({ timeout: 15_000 });
  check(`${label}: host sees "You ended the session"`, true);

  const overlay = guestPeer.page.locator('[role="alertdialog"]');
  await overlay.waitFor({ timeout: 25_000 });
  check(`${label}: guest lands on a terminal screen`, true);
  const text = (await overlay.innerText()).replace(/\s+/g, " ");
  if (!/the other person ended the session/i.test(text)) {
    // Known, separately-tracked wording race: the channel teardown can beat
    // the server's peer-ended event, so the guest reads "disconnected".
    console.log(`  WARN  ${label}: guest terminal wording: ${text.slice(0, 120)}`);
  }
}

async function run() {
  const host = await newPeer(browsers.left, "HOST", peerOptions);
  const guest = await newPeer(browsers.right, "GUEST", peerOptions);

  // ------------------------------------------------------------ first pair
  console.log("\nPairing the first session");
  await host.page.goto(BASE);
  const firstRoom = await createSession(host.page);
  await host.page.getByText(LOBBY_TEXT).waitFor({ timeout: 15_000 });
  await pairInto(host, guest, firstRoom, "first session");

  // --------------------------------------------- cycle 1: end and recreate
  console.log("\nCycle 1: host ends, both recreate from the terminal screen");
  await endFromHost(host, guest, "cycle 1");

  const hostNew = await newSessionFromTerminal(host, "cycle 1 host");
  const guestNew = await newSessionFromTerminal(guest, "cycle 1 guest");
  check(
    "cycle 1: the two peers created distinct fresh rooms",
    hostNew.url !== guestNew.url,
    `${hostNew.url} vs ${guestNew.url}`,
  );

  // Pair the recreated sessions: guest abandons its own lobby and joins the
  // host's new room, exactly like a user pasting the newly shared link.
  await pairInto(host, guest, hostNew.url, "cycle 1 re-pair");

  // --------------------------------------------- cycle 2: do it all again
  console.log("\nCycle 2: the whole cycle must work twice in a row");
  await endFromHost(host, guest, "cycle 2");

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
  await endFromHost(host, guest, "cycle 3");

  await host.page.reload();
  // The room is spent, so after a reload the terminal screen must come back
  // (as "already ended") rather than a broken lobby or a crash.
  await host.page.getByText(TERMINAL_TEXT).first().waitFor({ timeout: 20_000 });
  check("reload on the terminal screen still shows a terminal screen", true);

  const afterReload = await newSessionFromTerminal(host, "post-reload host");
  check(
    "post-reload: New session leads to a working lobby",
    afterReload.ok,
    afterReload.url,
  );

  // ------------------------------------- Back home, then create again
  console.log('\n"Back home" from the terminal screen, then create again');
  const backHome = guest.page.getByRole("link", { name: /back home/i });
  await backHome.waitFor({ timeout: 15_000 });
  await clickUntilUrlChanges(guest.page, backHome, { attempts: 10 });
  await guest.page
    .getByRole("button", { name: /create a private session/i })
    .waitFor({ timeout: 15_000 });
  check('guest: "Back home" lands on the home page', true);

  await createSession(guest.page);
  const guestHomeLobby = await expectFreshLobby(guest, "guest via home");

  // Final sanity: those two fresh sessions can pair too.
  if (afterReload.ok && guestHomeLobby) {
    await pairInto(host, guest, afterReload.url, "final re-pair");
  }

  await Promise.all([host.context.close(), guest.context.close()]);
}

try {
  console.log(`Recreate-a-session regression checks against ${BASE}${HEADED ? " (headed)" : ""}`);
  await run();
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await closeBrowsers(browsers);
}

if (state.failures > 0) {
  console.log(`\nBUG screenshots (if any) are under ${SCREENSHOT_DIR}`);
}
console.log(
  state.failures === 0
    ? `\nAll ${state.passes} recreate checks passed - the reported bug did NOT reproduce.`
    : `\n${state.failures} check(s) failed (${state.passes} passed) - see FAIL lines above.`,
);
process.exit(state.failures === 0 ? 0 : 1);
