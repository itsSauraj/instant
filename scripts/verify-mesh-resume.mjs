/**
 * Reload-resume checks for the Phase 1 mesh: a participant who reloads must
 * reclaim the SAME seat via the resume token, WITHOUT the host re-admitting,
 * while everyone else's session continues untouched and the roster shows the
 * reloader as briefly reconnecting rather than gone. Then the same for the
 * HOST: a host reload must not kill the room and must not cost the crown.
 *
 *   node scripts/verify-mesh-resume.mjs [baseUrl] [--headed]
 *
 * Assertions run on BOTH sides: the reloader and the observers.
 * Selector contract: scripts/mesh-shared.mjs. Keep this file ASCII-only.
 */

import {
  admitButton,
  closeButton,
  createRoomAsHost,
  ensureCapacity,
  knockAndAdmit,
  nameGateField,
  openSettings,
  launchMeshBrowser,
  listScreenshots,
  makeChecker,
  newParticipant,
  openNotes,
  parseCliArgs,
  rosterSnapshot,
  sendNote,
  shot,
  SCREENSHOT_DIR,
  terminalOverlay,
  waitForConnected,
  waitForRosterName,
  waitingForApproval,
  wait,
} from "./mesh-shared.mjs";

const { base: BASE, headed: HEADED } = parseCliArgs();
const { check, skip, state } = makeChecker();

const browser = await launchMeshBrowser({ headed: HEADED });

/**
 * Samples an observer's roster region while somebody reloads. Records whether
 * the reloader's name ever vanished from the roster (it must not) and whether
 * an away/reconnecting marker was seen alongside it (it should be, briefly).
 * Only the roster region itself is sampled -- the page body would false-match
 * the name inside note attributions.
 */
function watchRoster(page, name) {
  const outcome = { vanished: false, sawAway: false, samples: 0 };
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        const text = await rosterSnapshot(page);
        if (text !== null) {
          outcome.samples += 1;
          if (!text.includes(name)) outcome.vanished = true;
          if (text.includes(name) && /away|reconnect/i.test(text)) outcome.sawAway = true;
        }
      } catch {
        // Mid-render; sample again.
      }
      await wait(120);
    }
  })();
  return { outcome, stop: async () => ((stopped = true), await loop, outcome) };
}

/** Watches the host page for any admit prompt: resume must never knock. */
function watchForKnock(hostPage) {
  const outcome = { knocked: false };
  let stopped = false;
  const button = admitButton(hostPage);
  const loop = (async () => {
    while (!stopped) {
      if (await button.isVisible().catch(() => false)) outcome.knocked = true;
      await wait(150);
    }
  })();
  return { outcome, stop: async () => ((stopped = true), await loop, outcome) };
}

/** Watches a reloading page for the name gate: a resume must never re-prompt. */
function watchForGate(page) {
  const outcome = { gated: false };
  let stopped = false;
  const field = nameGateField(page);
  const loop = (async () => {
    while (!stopped) {
      if (await field.isVisible().catch(() => false)) outcome.gated = true;
      await wait(150);
    }
  })();
  return { outcome, stop: async () => ((stopped = true), await loop, outcome) };
}

async function assertNoteFanout(sender, receivers, text, label) {
  await openNotes(sender.page);
  await sendNote(sender.page, text);
  let delivered = 0;
  for (const receiver of receivers) {
    await openNotes(receiver.page);
    try {
      await receiver.page.getByText(text).first().waitFor({ timeout: 15_000 });
      delivered += 1;
    } catch {
      // Counted below.
    }
  }
  check(label, delivered === receivers.length, `${delivered}/${receivers.length} deliveries`);
}

async function run() {
  const names = ["Ada", "Ben", "Cleo"];
  const [host, ben, cleo] = await Promise.all(
    names.map((name, i) => newParticipant(browser, name, { name })),
  );

  // ------------------------------------------------------------------ set-up
  console.log("\nSeating a 3-participant room");
  const roomUrl = await createRoomAsHost(host, BASE);
  await knockAndAdmit(host, ben, roomUrl);
  await ensureCapacity(host, 3); // rooms start at 2; the third seat is deliberate
  await knockAndAdmit(host, cleo, roomUrl);
  for (const participant of [host, ben, cleo]) {
    for (const name of names) await waitForRosterName(participant.page, name);
  }
  check("all three participants are seated and see each other", true);
  for (const p of [host, ben, cleo]) await waitForConnected(p.page, { peers: 2 });
  for (const p of [host, ben, cleo]) await openNotes(p.page);
  await assertNoteFanout(host, [ben, cleo], "warm-up note from Ada", "the mesh works before any reload");

  // ------------------------------------------------------- guest reload
  console.log("\nReloading a guest (Cleo): same seat, no re-admission");
  const adaWatch = watchRoster(host.page, "Cleo");
  const benWatch = watchRoster(ben.page, "Cleo");
  const knockWatch = watchForKnock(host.page);
  const gateWatch = watchForGate(cleo.page);

  await cleo.page.reload();

  // Reloader side: back into the room without a knock gate.
  let cleoBack = true;
  try {
    for (const name of names) await waitForRosterName(cleo.page, name, { timeout: 30_000 });
  } catch (error) {
    cleoBack = false;
    check("the reloaded guest lands back in the room with the full roster", false, error.message);
  }
  if (cleoBack) check("the reloaded guest lands back in the room with the full roster", true);
  if (cleoBack) await waitForConnected(cleo.page, { peers: 2 }).catch(() => {});
  check(
    "the reloaded guest never saw the waiting-for-approval gate",
    !(await waitingForApproval(cleo.page).isVisible().catch(() => false)),
  );

  // Give the away->back transition a moment to be observable, then stop.
  await wait(1000);
  const adaSaw = await adaWatch.stop();
  const benSaw = await benWatch.stop();
  const knocks = await knockWatch.stop();
  const gates = await gateWatch.stop();

  check(
    "the host never got a knock for the reload (resume skipped admission)",
    knocks.knocked === false,
  );
  check(
    "the reloaded guest was never re-prompted for a name (resume skips the gate)",
    gates.gated === false,
  );
  check(
    "Cleo never VANISHED from the host's roster during the reload",
    adaSaw.samples > 0 && !adaSaw.vanished,
    `samples=${adaSaw.samples} vanished=${adaSaw.vanished}`,
  );
  check(
    "Cleo never VANISHED from Ben's roster during the reload",
    benSaw.samples > 0 && !benSaw.vanished,
    `samples=${benSaw.samples} vanished=${benSaw.vanished}`,
  );
  check(
    "an observer saw Cleo marked away/reconnecting during the reload",
    adaSaw.sawAway || benSaw.sawAway,
    "no away/reconnecting marker was sampled on either observer",
  );

  // Same seat, not a duplicate: exactly one Cleo row afterwards.
  const hostRoster = (await rosterSnapshot(host.page)) ?? "";
  const cleoRows = (hostRoster.match(/Cleo/g) ?? []).length;
  check("the roster holds exactly one Cleo after the resume", cleoRows === 1, `rows=${cleoRows} in "${hostRoster.slice(0, 160)}"`);
  check(
    "no observer was pushed to a terminal screen by the guest reload",
    !(await terminalOverlay(host.page).isVisible().catch(() => false)) &&
      !(await terminalOverlay(ben.page).isVisible().catch(() => false)),
  );
  await shot(host.page, "resume-01-after-guest-reload.png");

  // The reloaded seat is fully functional in BOTH directions.
  await assertNoteFanout(cleo, [host, ben], "Cleo is back", "the reloaded guest can still send to everyone");
  await assertNoteFanout(ben, [host, cleo], "Ben to the room after Cleo reload", "the reloaded guest still receives");

  // -------------------------------------------------------- host reload
  console.log("\nReloading the HOST (Ada): the room must survive");
  const benWatchHost = watchRoster(ben.page, "Ada");
  const cleoWatchHost = watchRoster(cleo.page, "Ada");
  const benKnockWatch = watchForKnock(ben.page); // in case of premature succession
  const hostGateWatch = watchForGate(host.page);

  await host.page.reload();

  let hostBack = true;
  try {
    for (const name of names) await waitForRosterName(host.page, name, { timeout: 30_000 });
  } catch (error) {
    hostBack = false;
    check("the reloaded host lands back in the room with the full roster", false, error.message);
  }
  if (hostBack) check("the reloaded host lands back in the room with the full roster", true);
  if (hostBack) await waitForConnected(host.page, { peers: 2 }).catch(() => {});

  await wait(1000);
  const benSawHost = await benWatchHost.stop();
  const cleoSawHost = await cleoWatchHost.stop();
  const benKnocks = await benKnockWatch.stop();
  const hostGates = await hostGateWatch.stop();

  check(
    "the reloading HOST was never re-prompted for a name (resume skips the gate)",
    hostGates.gated === false,
  );
  check(
    "the host's reload never produced a knock anywhere",
    benKnocks.knocked === false,
  );
  check(
    "the room did NOT end for the observers when the host reloaded",
    !(await terminalOverlay(ben.page).isVisible().catch(() => false)) &&
      !(await terminalOverlay(cleo.page).isVisible().catch(() => false)),
  );
  check(
    "Ada never VANISHED from Ben's roster during the host reload",
    benSawHost.samples > 0 && !benSawHost.vanished,
    `samples=${benSawHost.samples} vanished=${benSawHost.vanished}`,
  );
  check(
    "Ada never VANISHED from Cleo's roster during the host reload",
    cleoSawHost.samples > 0 && !cleoSawHost.vanished,
    `samples=${cleoSawHost.samples} vanished=${cleoSawHost.vanished}`,
  );
  check(
    "an observer saw the host marked away/reconnecting during the reload",
    benSawHost.sawAway || cleoSawHost.sawAway,
    "no away/reconnecting marker was sampled on either observer",
  );

  // The crown survived: the reloaded host still has host-only controls, and
  // nobody else acquired them (no premature succession). The host controls
  // live in the Settings rail tab.
  await openSettings(host.page);
  const hostStillHost = await closeButton(host.page)
    .isVisible()
    .catch(() => false);
  check("the reloaded host still holds the host controls", hostStillHost);
  await openSettings(ben.page);
  const benGotCrown = await closeButton(ben.page)
    .isVisible()
    .catch(() => false);
  check("no observer was promoted while the host was away", !benGotCrown);
  const hostRosterAfter = (await rosterSnapshot(ben.page)) ?? "";
  check(
    "an observer's roster still marks a host",
    /host/i.test(hostRosterAfter),
    hostRosterAfter.slice(0, 200),
  );
  await shot(ben.page, "resume-02-after-host-reload.png");

  await assertNoteFanout(host, [ben, cleo], "Ada is back", "the reloaded host can still send to everyone");

  skip(
    "seat release after the grace window (awayTtlMs) expires",
    "would require a real 45s wait; covered at the HTTP level as a SKIP too",
  );

  await Promise.all([host, ben, cleo].map((p) => p.context.close().catch(() => {})));
}

try {
  console.log(`Mesh resume checks against ${BASE}${HEADED ? " (headed)" : ""}`);
  await run();
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await browser.close().catch(() => {});
}

const shots = await listScreenshots();
if (shots.length > 0) console.log(`\nScreenshots under ${SCREENSHOT_DIR}`);

console.log(
  `\n${state.failures === 0 ? "All resume checks passed." : `${state.failures} check(s) failed.`} (${state.passes} passed, ${state.failures} failed, ${state.skips} skipped)`,
);
process.exit(state.failures === 0 ? 0 : 1);
