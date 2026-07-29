/**
 * Proves the per-link negotiation watchdog in lib/peer-link.ts: an offer or
 * answer POST that is LOST (not merely late) leaves a link stuck in
 * "connecting" forever unless somebody re-offers. The watchdog re-offers
 * after 12s, up to 3 attempts, then fails the link so the mesh rebuilds it.
 *
 * Unlike verify-ice-race.mjs (which DELAYS description POSTs via an in-page
 * fetch patch), this suite DROPS them outright -- and it intercepts at the
 * Playwright ROUTE level, not by patching window.fetch. The dev server's
 * client runtime re-instruments window.fetch after hydration, which silently
 * un-patches an in-page override; route interception cannot be undone by the
 * page. Each swallowed POST is answered with a fake 200 {"ok":true}, so the
 * client fully believes the send succeeded. Drops are counted PER DESTINATION
 * PEER (the `to` field of the signal body), pinning them to one mesh link.
 *
 *   1. 3-way mesh: every link loses its first SDP in BOTH directions
 *   2. a pair where one side drops 3 in a row (the full retry budget)
 *   3. a pair where BOTH sides drop 4 -- beyond the budget -- so the link
 *      must be FAILED and REBUILT rather than left silently dead
 *   4. a renegotiation SDP lost AFTER the link is connected
 *
 * Every scenario asserts that SDPs really were dropped (otherwise the run
 * proves nothing), that the mesh still fully connects, and that every pair's
 * data channel works in BOTH directions afterwards.
 *
 *   node scripts/verify-sdp-drop.mjs [baseUrl]
 *
 * Keep this file ASCII-only.
 */

import {
  createRoomAsHost,
  ensureCapacity,
  knockAndAdmit,
  launchMeshBrowser,
  makeChecker,
  newParticipant,
  openNotes,
  parseCliArgs,
  sendNote,
  wait,
  waitForLinksConnected,
  waitForRosterName,
} from "./mesh-shared.mjs";

const { base: BASE } = parseCliArgs();
const { check, state } = makeChecker();

// Mirrors lib/peer-link.ts: NEGOTIATION_TIMEOUT_MS / MAX_NEGOTIATION_ATTEMPTS.
const WATCHDOG_MS = 12_000;
const MAX_ATTEMPTS = 3;

/**
 * Intercepts this participant's signalling POSTs and swallows the first
 * `dropPerPeer` description payloads per destination peer, fulfilling them
 * with a fake success. Everything else (SSE GET, control POSTs, candidates)
 * passes through untouched. Returns a handle with live counters and an
 * `arm()` switch for the post-connect scenario.
 */
async function installSdpDrop(participant, dropPerPeer, { armed = true } = {}) {
  const dropState = { dropped: 0, byPeer: new Map(), armed };
  await participant.context.route("**/api/signal/**", async (route) => {
    const request = route.request();
    if (dropState.armed && request.method() === "POST") {
      const body = request.postData() ?? "";
      if (body.includes('"kind":"description"')) {
        let to = "unknown";
        try {
          to = JSON.parse(body).to ?? "unknown";
        } catch {
          // Unparseable: still counted under "unknown".
        }
        const used = dropState.byPeer.get(to) ?? 0;
        if (used < dropPerPeer) {
          dropState.byPeer.set(to, used + 1);
          dropState.dropped += 1;
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: '{"ok":true}',
          });
          return;
        }
      }
    }
    await route.fallback();
  });
  participant.dropState = dropState;
  return dropState;
}

const droppedCount = (participant) => participant.dropState?.dropped ?? 0;

/** Remembers the current RTCPeerConnection handles to detect a rebuild. */
async function rememberLinks(page) {
  await page.evaluate(() => {
    const map = window.__instantPeerConnections;
    window.__initialLinks = map ? new Map(map) : new Map();
  });
}

async function linkWasRebuilt(page) {
  return page.evaluate(() => {
    const map = window.__instantPeerConnections;
    const initial = window.__initialLinks;
    if (!map || !initial) return false;
    for (const [peerId, pc] of map) {
      const before = initial.get(peerId);
      if (before && before !== pc) return true;
    }
    return false;
  });
}

async function signalingStates(page) {
  return page.evaluate(() => {
    const map = window.__instantPeerConnections;
    return map ? [...map.values()].map((pc) => pc.signalingState) : [];
  });
}

async function assertAllLinksWork(participants, tag) {
  for (const participant of participants) await openNotes(participant.page);
  for (const sender of participants) {
    const text = `${tag}: note from ${sender.name}`;
    await sendNote(sender.page, text);
    for (const receiver of participants) {
      if (receiver === sender) continue;
      let delivered = true;
      try {
        await receiver.page.getByText(text).first().waitFor({ timeout: 25_000 });
      } catch {
        delivered = false;
      }
      check(`${tag}: link ${sender.name} -> ${receiver.name} carries data`, delivered);
    }
  }
}

const browser = await launchMeshBrowser({ headed: false });

/**
 * Seats `names.length` participants; participant i swallows its first
 * drops[i] description POSTs per destination peer (0 = no interception).
 */
async function seatWithDrops(names, drops, { admitTimeout = 90_000, armed = true } = {}) {
  const participants = [];
  for (let i = 0; i < names.length; i += 1) {
    const participant = await newParticipant(browser, names[i], { name: names[i] });
    if (drops[i] > 0) await installSdpDrop(participant, drops[i], { armed });
    participants.push(participant);
  }
  const [host, ...guests] = participants;
  const roomUrl = await createRoomAsHost(host, BASE);
  await knockAndAdmit(host, guests[0], roomUrl, { timeout: admitTimeout });
  if (names.length > 2) {
    await ensureCapacity(host, names.length);
    for (const guest of guests.slice(1)) {
      await knockAndAdmit(host, guest, roomUrl, { timeout: admitTimeout });
    }
  }
  for (const participant of participants) {
    for (const name of names) await waitForRosterName(participant.page, name, { timeout: 45_000 });
  }
  return participants;
}

async function closeAll(participants) {
  await Promise.all(participants.map((p) => p.context.close().catch(() => {})));
}

// ---------------------------------------------------------------------------

async function scenarioMeshEveryLinkLoses() {
  console.log("\nScenario 1: 3-way mesh, every link loses its first SDP in both directions");
  const names = ["Ada", "Ben", "Cleo"];
  const drops = [1, 1, 1]; // per destination peer: every link, both directions
  const participants = await seatWithDrops(names, drops);

  // The watchdog fires at 12s per link; rounds can stack, so allow plenty.
  let connected = true;
  try {
    for (const participant of participants) {
      await waitForLinksConnected(participant.page, 2, { timeout: 100_000 });
    }
  } catch (error) {
    connected = false;
    check("scenario 1: the mesh fully connects despite the lost SDPs", false, error.message);
  }
  if (connected) check("scenario 1: the mesh fully connects despite the lost SDPs", true);

  // The run proves nothing unless SDPs really were dropped. A handshake needs
  // a description from BOTH ends of each link, and the first one per link is
  // always swallowed -- so each participant must have dropped one per link.
  let total = 0;
  for (let i = 0; i < participants.length; i += 1) {
    const dropped = droppedCount(participants[i]);
    total += dropped;
    check(
      `scenario 1: ${names[i]} really dropped an SDP on each of its 2 links`,
      dropped >= 2,
      `dropped=${dropped}`,
    );
  }
  check("scenario 1: every link lost SDPs in both directions (>= 6 total)", total >= 6, `total=${total}`);

  if (connected) await assertAllLinksWork(participants, "scenario 1");

  await closeAll(participants);
}

async function scenarioPairDropsThree() {
  console.log("\nScenario 2: a pair where one side drops 3 SDPs in a row (the full budget)");
  const names = ["Hana", "Bela"];
  const participants = await seatWithDrops(names, [3, 0]);
  const [host] = participants;

  // Worst case is the initial send plus re-offers at 12/24/36s with the last
  // retry landing; the peer's own watchdog can add rounds. Allow past that.
  let connected = true;
  try {
    for (const participant of participants) {
      await waitForLinksConnected(participant.page, 1, { timeout: 120_000 });
    }
  } catch (error) {
    connected = false;
    check("scenario 2: the pair connects after the watchdog re-offers", false, error.message);
  }
  if (connected) check("scenario 2: the pair connects after the watchdog re-offers", true);

  // She cannot have connected without landing a 4th description, so the full
  // budget must have been consumed -- this also proves the retries happened.
  const dropped = droppedCount(host);
  check(
    "scenario 2: the full budget of 3 descriptions was really swallowed",
    dropped === 3,
    `dropped=${dropped}`,
  );

  if (connected) await assertAllLinksWork(participants, "scenario 2");

  await closeAll(participants);
}

async function scenarioBeyondBudgetRebuilds() {
  console.log("\nScenario 3: both sides drop 4 SDPs -- beyond the budget, the link must be rebuilt");
  const names = ["Hana", "Bela"];
  const participants = await seatWithDrops(names, [4, 4]);
  const [host, guest] = participants;

  // Capture the initial RTCPeerConnection identities as soon as they exist,
  // so a rebuild (same peer, NEW connection object) is provable later.
  for (const participant of participants) {
    await participant.page
      .waitForFunction(() => (window.__instantPeerConnections?.size ?? 0) > 0, undefined, {
        timeout: 30_000,
      })
      .catch(() => {});
    await rememberLinks(participant.page);
  }

  // Exhausting the budget takes (MAX_ATTEMPTS + 1) watchdog periods, then the
  // failed link is rebuilt and negotiates from scratch.
  const budgetMs = (MAX_ATTEMPTS + 2) * WATCHDOG_MS;
  let connected = true;
  try {
    for (const participant of participants) {
      await waitForLinksConnected(participant.page, 1, { timeout: budgetMs + 120_000 });
    }
  } catch (error) {
    connected = false;
    check(
      "scenario 3: the link is rebuilt and connects rather than dying silently",
      false,
      error.message,
    );
  }
  if (connected) {
    check("scenario 3: the link is rebuilt and connects rather than dying silently", true);
  }

  check(
    "scenario 3: the drop really exceeded the retry budget",
    droppedCount(host) >= MAX_ATTEMPTS + 1 || droppedCount(guest) >= MAX_ATTEMPTS + 1,
    `host=${droppedCount(host)} guest=${droppedCount(guest)}`,
  );

  const rebuilt = (await linkWasRebuilt(host.page)) || (await linkWasRebuilt(guest.page));
  check(
    "scenario 3: at least one side replaced its RTCPeerConnection (a real rebuild)",
    rebuilt,
    `host=${await linkWasRebuilt(host.page)} guest=${await linkWasRebuilt(guest.page)}`,
  );

  if (connected) await assertAllLinksWork(participants, "scenario 3");

  await closeAll(participants);
}

async function scenarioPostConnectLoss() {
  console.log("\nScenario 4: a renegotiation SDP lost AFTER the link is connected");
  const names = ["Hana", "Bela"];
  // Interception installed but dormant: the link connects cleanly first.
  const participants = await seatWithDrops(names, [1, 0], { armed: false });
  const [host, guest] = participants;

  await waitForLinksConnected(host.page, 1, { timeout: 60_000 });
  await waitForLinksConnected(guest.page, 1, { timeout: 60_000 });

  // Arm the drop, then force a renegotiation by toggling the microphone on.
  // The same lost-SDP guarantee the watchdog gives while connecting must hold
  // here, or the session sits half-renegotiated with no recovery or error.
  host.dropState.armed = true;
  // The microphone control lives in the Audio & video tab.
  const mediaTab = host.page.getByRole("tab", { name: /audio & video|a\/v/i }).first();
  if (await mediaTab.isVisible().catch(() => false)) await mediaTab.click().catch(() => {});
  const micButton = host.page
    .getByRole("button", { name: /turn on (the )?microphone|microphone/i })
    .first();
  await micButton.waitFor({ timeout: 15_000 });
  await micButton.click();

  // Wait for the drop to actually happen, otherwise the scenario proves nothing.
  let dropHappened = false;
  const dropDeadline = Date.now() + 20_000;
  while (Date.now() < dropDeadline) {
    if (droppedCount(host) >= 1) {
      dropHappened = true;
      break;
    }
    await wait(300);
  }
  check("scenario 4: a renegotiation description really was dropped", dropHappened);

  if (dropHappened) {
    // Recovery contract: within a few watchdog periods the offer must be
    // re-sent (or the link rebuilt) so signaling returns to "stable" and the
    // renegotiated track actually flows.
    const deadline = Date.now() + (MAX_ATTEMPTS + 1) * WATCHDOG_MS + 15_000;
    let stable = false;
    while (Date.now() < deadline) {
      const states = await signalingStates(host.page);
      if (states.length > 0 && states.every((s) => s === "stable")) {
        stable = true;
        break;
      }
      await wait(500);
    }
    check(
      "scenario 4: signaling returns to stable after the lost renegotiation",
      stable,
      `states=${JSON.stringify(await signalingStates(host.page))}`,
    );

    const audioArrives = await guest.page
      .waitForFunction(
        () => {
          const map = window.__instantPeerConnections;
          if (!map) return false;
          for (const pc of map.values()) {
            for (const receiver of pc.getReceivers()) {
              if (receiver.track?.kind === "audio" && receiver.track.readyState === "live") {
                return true;
              }
            }
          }
          return false;
        },
        undefined,
        { timeout: 30_000 },
      )
      .then(() => true)
      .catch(() => false);
    check("scenario 4: the renegotiated audio track reaches the peer anyway", audioArrives);

    // Either way the session must still carry data.
    await assertAllLinksWork(participants, "scenario 4");
  }

  await closeAll(participants);
}

// ---------------------------------------------------------------------------

try {
  console.log(`Verifying SDP-LOSS recovery (drop, not delay) against ${BASE}`);
  console.log(
    `  (watchdog contract: re-offer after ${WATCHDOG_MS / 1000}s, up to ${MAX_ATTEMPTS} attempts, then rebuild)`,
  );
  await scenarioMeshEveryLinkLoses();
  await scenarioPairDropsThree();
  await scenarioBeyondBudgetRebuilds();
  await scenarioPostConnectLoss();
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await browser.close().catch(() => {});
}

console.log(
  `\n${state.failures === 0 ? "All SDP-drop checks passed." : `${state.failures} check(s) failed.`} (${state.passes} passed, ${state.failures} failed, ${state.skips} skipped)`,
);
process.exit(state.failures === 0 ? 0 : 1);
