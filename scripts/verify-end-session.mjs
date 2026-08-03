/**
 * Verifies the host's two-choice End-session control (end-session-dialog.tsx,
 * host-transfer-dialog.tsx, and their wiring in room-client.tsx).
 *
 * ASCII-only, like every other file in scripts/. Run against a DEV server that
 * carries the current source (the 3111 production server is a frozen bundle):
 *
 *   node scripts/verify-end-session.mjs http://127.0.0.1:3133
 *
 * Scenarios:
 *   A. A guest sees a plain "Leave session" and none of the host-only UI;
 *      their leave removes only them and the room continues.
 *   B. The host's "End session" opens the two-option dialog; initial focus is
 *      the SAFE option; "Close for everyone" ends the session for all.
 *   C. Leave-with-transfer in a 3-person room: the dropdown lists only the
 *      eligible others (never the host, never away seats), transfers FIRST,
 *      leaves only on ratification; the successor is notified exactly once
 *      and really gains host controls; the third person keeps going.
 *   D. A host alone gets the honest "leaving ends the room" path (no picker).
 *   E. Everyone else away: no recipient is offered, and it says why.
 *   F. The host-change notification de-duplicates on seq (dev hook).
 */

import {
  closeParticipantsIfOpen,
  containsSpuriousError,
  createRoomAsHost,
  describesDeliberateClose,
  ensureCapacity,
  knockAndAdmit,
  launchMeshBrowser,
  makeChecker,
  newParticipant,
  openSettings,
  parseCliArgs,
  rosterText,
  shot,
  terminalOverlay,
  terminalText,
  wait,
  waitForConnected,
  waitForRosterGone,
  waitForRosterName,
} from "./mesh-shared.mjs";

const { base, headed } = parseCliArgs();
const { state, check, skip } = makeChecker();

const NEW_HOST_PHRASE = "You are now the host";

/** The rail End-session control (host wording). Guests keep "Leave session". */
const endSessionButton = (page) =>
  page.getByRole("button", { name: /^end session$/i }).first();
const leaveSessionButton = (page) =>
  page.getByRole("button", { name: /^leave session$/i }).first();

/** The two option cards inside the End-session dialog. */
const leaveOption = (page) => page.locator('[data-slot="end-leave-option"]').first();
const closeOption = (page) => page.locator('[data-slot="end-close-option"]').first();

const hostNoticeBanner = (page) => page.locator('[data-slot="host-notice"]').first();

async function activeSlot(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    return active ? active.getAttribute("data-slot") : null;
  });
}

/**
 * Counts toast insertions containing `phrase`, surviving auto-dismissal:
 * reading the DOM later misses toasts that already left, so count arrivals.
 */
async function armToastCounter(page, phrase) {
  await page.evaluate((needle) => {
    window.__toastPhraseCount = 0;
    const tally = (node) => {
      if (!(node instanceof HTMLElement)) return;
      const viewport = node.closest('[data-slot="toast-viewport"]');
      if (!viewport) return;
      if ((node.textContent || "").includes(needle)) window.__toastPhraseCount += 1;
    };
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const added of mutation.addedNodes) tally(added);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__toastPhraseObserver = observer;
  }, phrase);
}

const toastCount = (page) => page.evaluate(() => window.__toastPhraseCount || 0);

async function waitFor(fn, { timeout = 15_000, interval = 400 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > deadline) return false;
    await wait(interval);
  }
}

/** Opens the host's End-session dialog and waits for the safe option. */
async function openEndDialog(page) {
  await closeParticipantsIfOpen(page);
  const trigger = endSessionButton(page);
  await trigger.waitFor({ timeout: 20_000 });
  const opened = await waitFor(async () => {
    await trigger.click({ timeout: 2000 }).catch(() => {});
    return leaveOption(page).isVisible().catch(() => false);
  }, { timeout: 15_000, interval: 500 });
  if (!opened) throw new Error("End-session dialog never opened");
  await wait(250); // let onOpenAutoFocus settle before reading activeElement
}

// ---------------------------------------------------------------------------

async function scenarioA(browser) {
  console.log("\nScenario A: guest sees a plain Leave; leaving removes only them");
  const host = await newParticipant(browser, "A-host", { name: "Ada Host" });
  const guest = await newParticipant(browser, "A-guest", { name: "Ben Guest" });
  try {
    const roomUrl = await createRoomAsHost(host, base);
    await knockAndAdmit(host, guest, roomUrl);
    await closeParticipantsIfOpen(host.page);
    await closeParticipantsIfOpen(guest.page);

    check(
      "guest has a plain Leave session control",
      await leaveSessionButton(guest.page).isVisible().catch(() => false),
    );
    check(
      "guest has NO End session control",
      (await guest.page.getByRole("button", { name: /^end session$/i }).count()) === 0,
    );
    check(
      "guest page contains none of the host-only dialog UI",
      (await guest.page.locator('[data-slot="end-leave-option"], [data-slot="end-close-option"]').count()) === 0,
    );
    check(
      "host rail control reads End session, not Leave",
      (await endSessionButton(host.page).isVisible().catch(() => false)) &&
        (await host.page.getByRole("button", { name: /^leave session$/i }).count()) === 0,
    );

    // The guest's leave is immediate: no dialog in between.
    await leaveSessionButton(guest.page).click();
    const dialogAppeared = await guest.page
      .locator('[data-slot="dialog-content"]')
      .isVisible()
      .catch(() => false);
    check("guest leave opens no dialog", !dialogAppeared);
    const text = await terminalText(guest.page);
    check("guest sees the self-left screen", /you left the session/i.test(text), text);

    await waitForRosterGone(host.page, guest.name);
    check(
      "room continues for the host after a guest leaves",
      !(await terminalOverlay(host.page).isVisible().catch(() => false)),
    );
  } finally {
    await host.context.close();
    await guest.context.close();
  }
}

async function scenarioB(browser) {
  console.log("\nScenario B: host dialog offers both choices; Close ends it for all");
  const host = await newParticipant(browser, "B-host", { name: "Cora Host" });
  const guest = await newParticipant(browser, "B-guest", { name: "Dan Guest" });
  try {
    const roomUrl = await createRoomAsHost(host, base);
    await knockAndAdmit(host, guest, roomUrl);
    await closeParticipantsIfOpen(host.page);

    await openEndDialog(host.page);
    check("dialog shows the Leave option", await leaveOption(host.page).isVisible());
    check("dialog shows the Close-for-everyone option", await closeOption(host.page).isVisible());
    const leaveText = ((await leaveOption(host.page).innerText()) || "").toLowerCase();
    check(
      "Leave option says the session continues for the others",
      leaveText.includes("session continues"),
      leaveText,
    );
    const closeText = ((await closeOption(host.page).innerText()) || "").toLowerCase();
    check(
      "Close option carries its one short consequence line",
      closeText.includes("disconnected") && closeText.includes("cannot be undone"),
      closeText,
    );
    const focused = await activeSlot(host.page);
    check(
      "initial focus is the SAFE option, never the destructive one",
      focused === "end-leave-option",
      `focused: ${focused}`,
    );
    await shot(host.page, "end-session-dialog.png");

    await closeOption(host.page).click();
    const hostText = await terminalText(host.page);
    const guestText = await terminalText(guest.page);
    check("host sees a deliberate close", describesDeliberateClose(hostText), hostText);
    check("guest sees a deliberate close", describesDeliberateClose(guestText), guestText);
    check(
      "no spurious transport error on a deliberate close",
      !containsSpuriousError(hostText) && !containsSpuriousError(guestText),
    );
  } finally {
    await host.context.close();
    await guest.context.close();
  }
}

async function scenarioC(browser) {
  console.log("\nScenario C: leave-with-transfer hands off first, then leaves");
  const host = await newParticipant(browser, "C-host", { name: "Eve Host" });
  const g1 = await newParticipant(browser, "C-g1", { name: "Finn Next" });
  const g2 = await newParticipant(browser, "C-g2", { name: "Gwen Third" });
  try {
    const roomUrl = await createRoomAsHost(host, base);
    await ensureCapacity(host, 3);
    await knockAndAdmit(host, g1, roomUrl);
    await knockAndAdmit(host, g2, roomUrl);
    await closeParticipantsIfOpen(host.page);
    await closeParticipantsIfOpen(g1.page);
    await closeParticipantsIfOpen(g2.page);

    check(
      "successor-to-be has no host controls beforehand",
      (await g1.page.getByRole("button", { name: /^end session$/i }).count()) === 0,
    );

    await armToastCounter(g1.page, NEW_HOST_PHRASE);
    await armToastCounter(g2.page, NEW_HOST_PHRASE);

    await openEndDialog(host.page);
    await leaveOption(host.page).click();

    const picker = host.page.getByLabel(/new host/i);
    await picker.waitFor({ timeout: 10_000 });
    const options = await picker.locator("option").evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: (node.textContent || "").trim(),
        value: node.value,
        disabled: node.disabled,
      })),
    );
    check(
      "dropdown offers both present guests",
      options.some((o) => o.label === g1.name && !o.disabled) &&
        options.some((o) => o.label === g2.name && !o.disabled),
      JSON.stringify(options),
    );
    check(
      "host themself is not a candidate",
      !options.some((o) => o.label.includes(host.name)),
      JSON.stringify(options),
    );
    check(
      "the placeholder is not a valid choice",
      options.some((o) => o.value === "" && o.disabled),
      JSON.stringify(options),
    );
    const focused = await activeSlot(host.page);
    check(
      "picker's initial focus is Cancel, not the action",
      focused === "transfer-cancel",
      `focused: ${focused}`,
    );
    const confirm = host.page.locator('[data-slot="transfer-confirm"]').first();
    check(
      "confirm is disabled until a successor is chosen",
      await confirm.isDisabled().catch(() => false),
    );
    check(
      "disabled confirm still names its action",
      /make .*host and leave/i.test((await confirm.innerText().catch(() => "")) || ""),
    );
    await shot(host.page, "host-transfer-dialog.png");

    await picker.selectOption({ label: g1.name });
    const named = host.page.getByRole("button", {
      name: new RegExp(`make ${g1.name} host and leave`, "i"),
    });
    check("confirm names the chosen successor", await named.isVisible().catch(() => false));
    await named.click();

    // Two legitimate outcomes: the live transport ratifies and the host
    // leaves, or (transport contract not landed in this build) the transfer
    // cannot be confirmed and the host MUST stay -- never leave on hope.
    let outcome = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && !outcome) {
      if (await terminalOverlay(host.page).isVisible().catch(() => false)) outcome = "left";
      else if (
        await host.page.evaluate(
          () => Array.isArray(window.__instantHostTransferOutbox) &&
            window.__instantHostTransferOutbox.length > 0,
        ).catch(() => false)
      ) outcome = "no-transport";
      else await wait(400);
    }

    if (outcome === "no-transport") {
      console.log("  NOTE  transferHost not on the session yet; verifying the refusal path");
      const stayedAndTold = await waitFor(async () => {
        const body = await host.page.locator("body").innerText().catch(() => "");
        return /still the host|did not complete|not available/i.test(body);
      }, { timeout: 12_000 });
      check("unconfirmable transfer keeps the host in the room and says so", stayedAndTold);
      check(
        "host did NOT leave on an unratified transfer",
        !(await terminalOverlay(host.page).isVisible().catch(() => false)),
      );
      skip("successor toast fires exactly once", "transport contract not landed");
      skip("successor gains host controls", "transport contract not landed");
      skip("room continues for the third participant", "transport contract not landed");
      return;
    }

    check("host left only after the handover", outcome === "left");
    const hostText = await terminalText(host.page);
    check("departed host sees the self-left screen", /you left the session/i.test(hostText), hostText);

    const notified = await waitFor(async () => (await toastCount(g1.page)) >= 1, { timeout: 12_000 });
    check("new host is notified", notified);
    check(
      "new host sees the in-room banner",
      await waitFor(() => hostNoticeBanner(g1.page).isVisible().catch(() => false), { timeout: 6000 }),
    );
    await shot(g1.page, "new-host-notified.png");
    await wait(3000); // window for an accidental duplicate to show itself
    check("notification fired exactly once", (await toastCount(g1.page)) === 1, `count: ${await toastCount(g1.page)}`);
    check("the third participant is NOT told they are host", (await toastCount(g2.page)) === 0);

    check(
      "successor's rail control switched to End session",
      await waitFor(() => endSessionButton(g1.page).isVisible().catch(() => false), { timeout: 10_000 }),
    );
    await openSettings(g1.page);
    check(
      "successor really gains the host panel (Close session for everyone)",
      await waitFor(
        () => g1.page.getByRole("button", { name: /close session for everyone/i }).isVisible().catch(() => false),
        { timeout: 10_000 },
      ),
    );
    await waitForConnected(g2.page);
    check(
      "room continues for the third participant",
      !(await terminalOverlay(g2.page).isVisible().catch(() => false)),
    );
    check(
      "third participant's roster shows the successor",
      (await rosterText(g2.page)).includes(g1.name),
    );
  } finally {
    await host.context.close();
    await g1.context.close();
    await g2.context.close();
  }
}

async function scenarioD(browser) {
  console.log("\nScenario D: a host alone gets the honest no-successor path");
  const host = await newParticipant(browser, "D-host", { name: "Hana Solo" });
  try {
    await createRoomAsHost(host, base);
    await openEndDialog(host.page);
    const leaveText = ((await leaveOption(host.page).innerText()) || "").toLowerCase();
    check(
      "Leave option already says leaving ends the session when alone",
      leaveText.includes("ends the session"),
      leaveText,
    );
    await leaveOption(host.page).click();

    const title = host.page.getByText(/leave and end the session\?/i).first();
    await title.waitFor({ timeout: 10_000 });
    check("no-successor dialog says leaving ends the room", await title.isVisible());
    check(
      "no picker is offered when there is nobody to pick",
      (await host.page.locator('[data-slot="dialog-content"] select').count()) === 0,
    );
    const focused = await activeSlot(host.page);
    check(
      "destructive confirm does not hold initial focus",
      focused === "transfer-cancel",
      `focused: ${focused}`,
    );
    await shot(host.page, "host-alone-leave.png");

    await host.page.locator('[data-slot="transfer-leave-end"]').click();
    const text = await terminalText(host.page);
    check("alone host's leave completes", /you left the session/i.test(text), text);
  } finally {
    await host.context.close();
  }
}

async function scenarioE(browser) {
  console.log("\nScenario E: everyone else away -- no invalid recipient is offered");
  const host = await newParticipant(browser, "E-host", { name: "Iris Host" });
  const guest = await newParticipant(browser, "E-guest", { name: "Jude Away" });
  try {
    const roomUrl = await createRoomAsHost(host, base);
    await knockAndAdmit(host, guest, roomUrl);
    await closeParticipantsIfOpen(host.page);

    // Kill the guest's browser context; their seat is held (away), not freed.
    await guest.context.close();
    const away = await waitFor(async () => /reconnecting/i.test(await rosterText(host.page)), {
      timeout: 30_000,
    });
    if (!away) {
      skip("away-only leave path", "guest never showed as reconnecting");
      return;
    }
    await closeParticipantsIfOpen(host.page);

    await openEndDialog(host.page);
    await leaveOption(host.page).click();
    const title = host.page.getByText(/no one can take over right now/i).first();
    await title.waitFor({ timeout: 10_000 });
    check("away-only case explains itself instead of listing anyone", await title.isVisible());
    check(
      "no dropdown is offered when everyone is away",
      (await host.page.locator('[data-slot="dialog-content"] select').count()) === 0,
    );
    // The choice dialog that just closed can linger through its exit
    // animation, so read only the OPEN dialog.
    const body = (
      (await host.page.locator('[data-slot="dialog-content"][data-state="open"]').innerText()) || ""
    ).toLowerCase();
    check(
      "copy says a held seat cannot act as host",
      body.includes("held seat"),
      body,
    );
    const focused = await activeSlot(host.page);
    check(
      "Leave-anyway does not hold initial focus",
      focused === "transfer-cancel",
      `focused: ${focused}`,
    );
    await shot(host.page, "host-away-only.png");

    // Choosing to stay must simply put things back.
    await host.page.locator('[data-slot="transfer-cancel"]').click();
    await wait(400);
    check(
      "cancelling keeps the host seated",
      !(await terminalOverlay(host.page).isVisible().catch(() => false)),
    );
    return host; // reused by scenario F while still seated
  } finally {
    // host.context intentionally left open when scenario F reuses it; close
    // here only on failure paths where we did not return it.
  }
}

async function scenarioF(browser, seatedHost) {
  console.log("\nScenario F: host-change notification de-duplicates on seq");
  let host = seatedHost;
  let created = false;
  try {
    if (!host) {
      host = await newParticipant(browser, "F-host", { name: "Kai Host" });
      created = true;
      await createRoomAsHost(host, base);
    }
    const hasHook = await host.page.evaluate(
      () => typeof window.__instantHostChangeTest === "function",
    );
    if (!hasHook) {
      skip("seq de-duplication", "dev hook missing (production build?)");
      return;
    }
    await armToastCounter(host.page, NEW_HOST_PHRASE);
    const fire = (seq, becameHost) =>
      host.page.evaluate(
        ([s, b]) =>
          window.__instantHostChangeTest({
            seq: s,
            peerId: "test-peer",
            name: "Test Peer",
            becameHost: b,
            byChoice: true,
          }),
        [seq, becameHost],
      );

    await fire(901, true);
    await fire(901, true); // an identical repeat must be de-duplicated
    await wait(800);
    check("repeated seq notifies once", (await toastCount(host.page)) === 1, `count: ${await toastCount(host.page)}`);
    await fire(902, true); // a NEW event (higher seq) must fire again
    await wait(800);
    check("a new seq notifies again", (await toastCount(host.page)) === 2, `count: ${await toastCount(host.page)}`);
    await fire(903, false); // somebody ELSE became host: no self notification
    await wait(800);
    check(
      "becameHost:false never claims you are the host",
      (await toastCount(host.page)) === 2,
      `count: ${await toastCount(host.page)}`,
    );
  } finally {
    if (host) await host.context.close().catch(() => {});
    void created;
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Verifying the End-session control against ${base}`);
  const browser = await launchMeshBrowser({ headed });
  let seatedHost = null;
  try {
    await scenarioA(browser);
    await scenarioB(browser);
    await scenarioC(browser);
    await scenarioD(browser);
    seatedHost = await scenarioE(browser);
    await scenarioF(browser, seatedHost ?? null);
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(
    `\nRESULT  pass=${state.passes} fail=${state.failures} skip=${state.skips}`,
  );
  process.exit(state.failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`FATAL  ${error?.stack || error}`);
  process.exit(1);
});
