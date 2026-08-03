/**
 * Drives N real Chromium contexts (one per participant, no shared origin
 * state) through the Phase 1 mesh flow: the host creates a room, everyone
 * else knocks, the host admits each one, notes fan out to every member with
 * the right attribution, one member leaves without disturbing the rest, and
 * the host's close lands everyone on a terminal screen.
 *
 *   node scripts/verify-mesh-e2e.mjs [baseUrl] [--headed] [--counts=3,5]
 *
 * Runs the whole flow for 3 AND for 5 participants, plus a mobile-width
 * 3-up pass. Screenshots land in artifacts/screenshots/ with ordered names
 * (mesh3-*, mesh5-*, mobile-*).
 *
 * The selector contract shared with the in-flight UI work lives in
 * scripts/mesh-shared.mjs. Keep this file ASCII-only.
 */

import {
  MOBILE_VIEWPORT,
  SCREENSHOT_DIR,
  admitButton,
  askToJoinButton,
  closeParticipantsIfOpen,
  closeRoomAsHost,
  containsSpuriousError,
  describesDeliberateClose,
  createRoomAsHost,
  ensureCapacity,
  joinAsGuest,
  knockAndAdmit,
  nameGateField,
  launchMeshBrowser,
  leaveButton,
  listScreenshots,
  makeChecker,
  newParticipant,
  openNotes,
  parseCliArgs,
  resetScreenshotDir,
  rosterText,
  sendNote,
  shot,
  terminalOverlay,
  terminalText,
  wait,
  waitForConnected,
  waitForRosterGone,
  waitForRosterName,
  waitingForApproval,
} from "./mesh-shared.mjs";

const { base: BASE, headed: HEADED } = parseCliArgs();
const countsArg = process.argv.find((arg) => arg.startsWith("--counts="));
const COUNTS = countsArg
  ? countsArg
      .slice("--counts=".length)
      .split(",")
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => Number.isFinite(n) && n >= 2 && n <= 7)
  : [3, 5];

const { check, skip, state } = makeChecker();
const NAMES = ["Ada", "Ben", "Cleo", "Dinah", "Emil", "Fern", "Gus"];

const browser = await launchMeshBrowser({ headed: HEADED });

/**
 * Finds the rendered note containing `text` and returns the innerText of its
 * enclosing bubble (the nearest marked container, list item or div), so an
 * author label rendered alongside the text is included.
 */
async function noteItemText(page, text) {
  const node = page.getByText(text).first();
  await node.waitFor({ timeout: 15_000 });
  const bubbleText = await node.evaluate((el) => {
    // `closest` starts at the element ITSELF, and getByText resolves to the
    // innermost match -- the markdown paragraph -- which trivially satisfies a
    // bare `div` selector. So it returned the paragraph and never reached the
    // author label sitting beside it. Require the explicit bubble hook.
    const bubble = el.closest('[data-slot="note"]');
    return (bubble ?? el.parentElement ?? el).innerText ?? el.textContent ?? "";
  });
  return bubbleText.replace(/\s+/g, " ").trim();
}

async function runMesh(count, prefix, viewport) {
  console.log(`\n=== ${count}-participant room (${prefix}) ===`);
  const names = NAMES.slice(0, count);
  const participants = [];
  for (let i = 0; i < count; i += 1) {
    participants.push(
      await newParticipant(browser, `${prefix}-${names[i]}`, { name: names[i], viewport }),
    );
  }
  const [host, ...guests] = participants;

  try {
    // ------------------------------------------------------------- creation
    console.log(`\n${prefix}: host creates the room`);
    const roomUrl = await createRoomAsHost(host, BASE);
    check(`${prefix}: host lands on a room URL`, /\/room\//.test(roomUrl), roomUrl);
    // The creator must skip the name gate (the home page plants a one-shot
    // sessionStorage marker) and be seated under their own name.
    const hostGated = await nameGateField(host.page).isVisible().catch(() => false);
    check(`${prefix}: the creator skips the name gate`, !hostGated);
    await waitForRosterName(host.page, host.name, { timeout: 20_000 });
    check(`${prefix}: the creator is seated under their own name`, true);
    await shot(host.page, `${prefix}-01-host-created.png`);

    // ------------------------------------------------- knocks and admissions
    console.log(`\n${prefix}: guests pass the name gate, knock, and are admitted`);
    for (let i = 0; i < guests.length; i += 1) {
      const guest = guests[i];

      if (i === 0) {
        // Assert the gate + knock choreography once, in detail.
        await guest.page.goto(roomUrl);
        const gate = nameGateField(guest.page);
        const sawGate = await gate
          .waitFor({ timeout: 15_000 })
          .then(() => true)
          .catch(() => false);
        check(`${prefix}: a visitor is stopped at the name gate`, sawGate);
        await shot(guest.page, `${prefix}-02a-join-gate.png`);

        // Nothing may reach the host before a name exists.
        await wait(2500);
        const earlyKnock = await admitButton(host.page).isVisible().catch(() => false);
        check(`${prefix}: no knock reaches the host before a name is given`, !earlyKnock);

        if (sawGate) {
          // An empty submit must be refused and still send nothing.
          await gate.fill("");
          await askToJoinButton(guest.page).click().catch(() => {});
          await wait(2000);
          const emptyKnock = await admitButton(host.page).isVisible().catch(() => false);
          const stillGated = await gate.isVisible().catch(() => false);
          check(
            `${prefix}: an empty name is refused and sends nothing`,
            !emptyKnock && stillGated,
            `knock=${emptyKnock} gated=${stillGated}`,
          );
        }

        await joinAsGuest(guest.page, roomUrl, guest.name);
        check(`${prefix}: a named joiner reaches the waiting-approval screen`, true);
        await shot(guest.page, `${prefix}-02b-guest-knocking.png`);

        // The name-scoped admit control proves the knock carried the name.
        const namedKnock = admitButton(host.page, guest.name);
        await namedKnock.waitFor({ timeout: 20_000 });
        check(`${prefix}: the knock arrives carrying the entered name`, true);
        await shot(host.page, `${prefix}-02c-host-sees-knock.png`);
        await namedKnock.click();
        await waitForRosterName(host.page, guest.name, { timeout: 30_000 });
      } else {
        await knockAndAdmit(host, guest, roomUrl);
      }
      check(`${prefix}: ${guest.name} is admitted and appears in the host's roster`, true);

      // The room starts at capacity 2; the host must deliberately raise the
      // limit before anyone beyond the first guest can even knock.
      if (i === 0 && count > 2) {
        await ensureCapacity(host, count);
        check(`${prefix}: host raises the participant limit to ${count}`, true);
      }
    }

    // ------------------------------------------------------- full connection
    console.log(`\n${prefix}: every page shows every participant`);
    for (const participant of participants) {
      for (const name of names) {
        await waitForRosterName(participant.page, name, { timeout: 30_000 });
      }
    }
    check(`${prefix}: all ${count} rosters contain all ${count} names`, true);
    // "All report connected": every page's badge must reach Connected (N-1)
    // before the data channels are exercised.
    for (const participant of participants) {
      await waitForConnected(participant.page, { peers: count - 1 });
    }
    check(`${prefix}: every participant reports Connected (${count - 1})`, true);
    await shot(host.page, `${prefix}-03a-all-connected-host.png`);
    await shot(guests[0].page, `${prefix}-03b-all-connected-guest.png`);

    // Markers: host / you. (The away marker is covered by verify-mesh-resume.)
    const hostRoster = await rosterText(host.page);
    check(
      `${prefix}: the roster marks the host`,
      /host/i.test(hostRoster),
      hostRoster.slice(0, 200),
    );
    check(
      `${prefix}: the roster marks "you" on your own row`,
      /you/i.test(hostRoster),
      hostRoster.slice(0, 200),
    );
    const guestRoster = await rosterText(guests[0].page);
    check(
      `${prefix}: a guest also sees host and you markers`,
      /host/i.test(guestRoster) && /you/i.test(guestRoster),
      guestRoster.slice(0, 200),
    );

    // ----------------------------------------------------------------- notes
    console.log(`\n${prefix}: a note from one peer reaches ALL others, attributed`);
    for (const participant of participants) await openNotes(participant.page);

    // Deliberately does NOT contain the sender's name, so the attribution
    // check can only pass if the UI itself labels the note with its author.
    const noteText = `fanout probe from seat two (${prefix})`;
    await sendNote(guests[0].page, noteText);
    for (const participant of participants) {
      if (participant === guests[0]) continue;
      const item = await noteItemText(participant.page, noteText);
      check(
        `${prefix}: ${participant.name} received the note attributed to ${guests[0].name}`,
        item.includes(guests[0].name),
        `bubble text: ${item.slice(0, 160)}`,
      );
    }
    await shot(host.page, `${prefix}-04-notes-fanout.png`);

    // ----------------------------------------------------------------- leave
    console.log(`\n${prefix}: one peer leaves; the room continues unaffected`);
    const leaver = guests[guests.length - 1];
    const remaining = participants.filter((p) => p !== leaver);

    await closeParticipantsIfOpen(leaver.page);
    const leave = leaveButton(leaver.page);
    await leave.waitFor({ timeout: 15_000 });
    await leave.click();
    // Some UIs confirm the leave; accept and continue if so.
    const confirmLeave = leaver.page
      .getByRole("button", { name: /^leave$|yes.*leave|confirm/i })
      .last();
    if (await confirmLeave.isVisible().catch(() => false)) {
      await confirmLeave.click().catch(() => {});
    }

    for (const participant of remaining) {
      await waitForRosterGone(participant.page, leaver.name, { timeout: 30_000 });
    }
    check(`${prefix}: ${leaver.name} disappears from every remaining roster`, true);
    for (const participant of remaining) {
      await waitForConnected(participant.page, { peers: remaining.length - 1 });
    }

    const afterLeaveNote = `still here after ${leaver.name} left (${prefix})`;
    await sendNote(host.page, afterLeaveNote);
    let delivered = 0;
    for (const participant of remaining) {
      if (participant === host) continue;
      try {
        await participant.page.getByText(afterLeaveNote).first().waitFor({ timeout: 15_000 });
        delivered += 1;
      } catch {
        // Counted below.
      }
    }
    check(
      `${prefix}: the survivors' mesh still works after the leave`,
      delivered === remaining.length - 1,
      `${delivered}/${remaining.length - 1} deliveries`,
    );
    await shot(host.page, `${prefix}-05-after-leave.png`);

    // ----------------------------------------------------------------- close
    console.log(`\n${prefix}: the host closes; everyone lands on a terminal screen`);
    await closeRoomAsHost(host);

    for (const participant of remaining) {
      const text = await terminalText(participant.page).catch(() => null);
      const isHost = participant === host;
      check(
        `${prefix}: ${participant.name} reaches a terminal screen`,
        typeof text === "string",
        text ?? "no [role=alertdialog] appeared",
      );
      if (typeof text === "string" && !isHost) {
        // The end-reason wording contract: a deliberate close must never be
        // reported as a disconnect.
        check(
          `${prefix}: ${participant.name} is told the host CLOSED it, not that it dropped`,
          describesDeliberateClose(text),
          text.slice(0, 160),
        );
        // A clean close must not surface a spurious transport error either
        // (the teardown race the old 2-peer suite kept visible).
        check(
          `${prefix}: ${participant.name} sees no spurious error on a clean close`,
          !containsSpuriousError(text),
          text.slice(0, 160),
        );
      }
    }
    await shot(host.page, `${prefix}-06a-ended-host.png`);
    await shot(remaining[1].page, `${prefix}-06b-ended-guest.png`);
  } finally {
    await Promise.all(participants.map((p) => p.context.close().catch(() => {})));
  }
}

try {
  console.log(`Mesh end-to-end checks against ${BASE}${HEADED ? " (headed)" : ""}`);
  console.log(`Participant counts: ${COUNTS.join(", ")} (plus a mobile 3-up pass)`);
  await resetScreenshotDir();

  for (const count of COUNTS) {
    try {
      await runMesh(count, `mesh${count}`);
    } catch (error) {
      state.failures += 1;
      console.log(`\n  ERROR  mesh${count}: ${error.message}`);
    }
  }

  // Mobile-width pass: same flow at a phone viewport.
  try {
    await runMesh(3, "mobile", MOBILE_VIEWPORT);
  } catch (error) {
    state.failures += 1;
    console.log(`\n  ERROR  mobile: ${error.message}`);
  }
} finally {
  await browser.close().catch(() => {});
}

const shots = await listScreenshots();
console.log(`\nScreenshots: ${shots.length} image(s) written to ${SCREENSHOT_DIR}`);
for (const name of shots) console.log(`  ${name}`);

console.log(
  `\n${state.failures === 0 ? "All mesh end-to-end checks passed." : `${state.failures} check(s) failed.`} (${state.passes} passed, ${state.failures} failed, ${state.skips} skipped)`,
);
process.exit(state.failures === 0 ? 0 : 1);
