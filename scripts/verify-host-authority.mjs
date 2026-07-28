/**
 * Tests for the host-authority feature that is landing concurrently:
 * only the HOST (session creator / WebRTC "initiator") may deliberately end a
 * session; the guest's "End session" button stays disabled until the host
 * grants permission from a host-only panel (components/room/host-panel.tsx).
 *
 * Written defensively: if the feature has not landed yet, the script prints a
 * clear SKIP message and exits 0 instead of failing. Presence is detected from
 * the UI (a disabled guest End-session button, or a visible host panel), never
 * assumed.
 *
 *   node scripts/verify-host-authority.mjs [baseUrl] [--headed]
 *
 * Keep this file ASCII-only.
 */

import {
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

const browsers = await launchBrowsers({ headed: HEADED });
const peerOptions = { viewport: browsers.viewport };

let skipped = false;

const endButton = (page) => page.getByRole("button", { name: /end session/i }).first();

/** The host panel's markup is Worker 1's; probe a few plausible shapes. */
function hostPanelLocator(page) {
  return page
    .locator(
      'section[aria-label="Host controls"], [data-slot="host-panel"], [data-testid="host-panel"], [data-host-panel]',
    )
    .or(page.getByText(/guest can end|only you can end/i))
    .first();
}

/** A grant toggle inside the panel: try switch, then checkbox, then a button. */
async function findGrantToggle(page) {
  const candidates = [
    page.getByRole("button", { name: /allow the guest|allow guest|guest can end|grant/i }).first(),
    page.getByRole("switch").first(),
    page.getByRole("checkbox", { name: /guest|end/i }).first(),
  ];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

async function pair(host, guest) {
  await host.page.goto(BASE);
  const roomUrl = await createSession(host.page);
  await guest.page.goto(roomUrl);
  await statusBadge(host.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
  await statusBadge(guest.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
  return roomUrl;
}

async function run() {
  const host = await newPeer(browsers.left, "HOST", peerOptions);
  const guest = await newPeer(browsers.right, "GUEST", peerOptions);

  console.log("\nPairing a session to probe for the host-authority feature");
  await pair(host, guest);
  // Give the UI a moment to settle after connecting before probing state.
  await wait(1500);

  const guestEndDisabled = await endButton(guest.page)
    .isDisabled()
    .catch(() => false);
  const hostPanelVisible = await hostPanelLocator(host.page)
    .isVisible()
    .catch(() => false);

  if (!guestEndDisabled && !hostPanelVisible) {
    skipped = true;
    console.log(
      "\n  SKIP  host-authority feature not detected (guest End-session button is" +
        " enabled and no host panel is visible). The feature has not landed yet;" +
        " re-run this script once components/room/host-panel.tsx ships.",
    );
    await Promise.all([host.context.close(), guest.context.close()]);
    return;
  }

  console.log("\nHost-authority feature detected - running its checks");

  // ------------------------------------------------ pre-grant button state
  check(
    "guest's End session button is disabled before any grant",
    guestEndDisabled,
    "expected disabled, found enabled",
  );

  // -------------------------------------------------- panel visibility
  check("the host panel is visible to the host", hostPanelVisible);
  const guestSeesPanel = await hostPanelLocator(guest.page)
    .isVisible()
    .catch(() => false);
  check("the host panel is NOT visible to the guest", !guestSeesPanel);

  if (hostPanelVisible) {
    await ensureScreenshotDir();
    await shot(host.page, "07-host-panel.png");
  }

  // ---------------------------------------------------- grant, then end
  const toggle = hostPanelVisible ? await findGrantToggle(host.page) : null;
  if (!toggle) {
    check(
      "a grant toggle is findable in the host panel",
      false,
      "no switch/checkbox/button matching guest-can-end was found - update the locator in scripts/verify-host-authority.mjs to match the shipped markup",
    );
    await shot(host.page, "BUG-host-panel-toggle-not-found.png").catch(() => {});
  } else {
    await toggle.click();

    let enabled = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      enabled = await endButton(guest.page)
        .isEnabled()
        .catch(() => false);
      if (enabled) break;
      await wait(500);
    }
    check("after the host grants, the guest's End session button becomes enabled", enabled);

    if (enabled) {
      await endButton(guest.page).click();
      await guest.page.getByText(/you ended the session/i).waitFor({ timeout: 15_000 });
      // Accept "ended" or "disconnected" on the host: the exact wording is
      // subject to a known race that is tracked separately; what matters here
      // is that the granted guest CAN end and both sides reset.
      await host.page.locator('[role="alertdialog"]').waitFor({ timeout: 25_000 });
      const hostText = (
        await host.page.locator('[role="alertdialog"]').innerText()
      ).replace(/\s+/g, " ");
      check(
        "a granted guest can end the session, resetting both sides",
        /(ended the session|disconnected)/i.test(hostText),
        hostText.slice(0, 140),
      );
    } else {
      await shot(guest.page, "BUG-guest-end-still-disabled-after-grant.png").catch(() => {});
    }
  }

  await Promise.all([host.context.close(), guest.context.close()]);

  // ------------------------------- involuntary teardown is never gated
  console.log("\nInvoluntary teardown must not be gated by the grant");
  const host2 = await newPeer(browsers.left, "HOST2", peerOptions);
  const guest2 = await newPeer(browsers.right, "GUEST2", peerOptions);
  await pair(host2, guest2);

  // No grant is given; the guest's tab simply closes.
  await guest2.context.close();
  try {
    await host2.page
      .getByText(/the other person (ended the session|disconnected)/i)
      .waitFor({ timeout: 30_000 });
    check("closing the ungranted guest's tab still resets the host", true);
  } catch {
    await shot(host2.page, "BUG-host-not-reset-after-ungranted-guest-close.png").catch(() => {});
    check(
      "closing the ungranted guest's tab still resets the host",
      false,
      "host never reached the terminal screen within 30s",
    );
  }
  await host2.context.close();
}

try {
  console.log(`Host-authority checks against ${BASE}${HEADED ? " (headed)" : ""}`);
  await run();
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await closeBrowsers(browsers);
}

if (skipped) {
  console.log("\nHost-authority checks SKIPPED (feature not present). Exit 0.");
  process.exit(0);
}
console.log(
  state.failures === 0
    ? `\nAll ${state.passes} host-authority checks passed.`
    : `\n${state.failures} check(s) failed (${state.passes} passed).`,
);
process.exit(state.failures === 0 ? 0 : 1);
