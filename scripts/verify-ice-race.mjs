/**
 * Reproduces the signalling race that produces
 *   "Failed to execute 'addIceCandidate' on 'RTCPeerConnection':
 *    The remote description is null"
 * and asserts the MESH still connects -- every pair, not just one.
 *
 * Signalling payloads are independent POSTs with no ordering guarantee, so an
 * ICE candidate can overtake the SDP it belongs to. In a 3-participant mesh
 * there are 3 links, each with an offer and an answer that can be overtaken.
 * To make the race deterministic rather than hoping for the right timing,
 * `fetch` is patched in-page in EVERY participant to hold description POSTs
 * back while candidates go straight out.
 *
 *   node scripts/verify-ice-race.mjs [baseUrl]
 *
 * Keep this file ASCII-only.
 */

import { mkdirSync, writeFileSync } from "node:fs";

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
  waitForConnected,
  waitForRosterName,
} from "./mesh-shared.mjs";

const { base: BASE } = parseCliArgs();
/** Long enough that candidates certainly win, short enough to keep the run brisk. */
const SDP_DELAY_MS = 1200;

const { check, state } = makeChecker();

/** Delays only the SDP POSTs, so ICE candidates arrive first on every link. */
const DELAY_SDP = (delayMs) => {
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    const body = init?.body;
    if (
      init?.method === "POST" &&
      String(url).includes("/api/signal/") &&
      typeof body === "string" &&
      body.includes('"kind":"description"')
    ) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return original(input, init);
  };
};

const browser = await launchMeshBrowser({ headed: false });

async function run() {
  const errors = [];
  const names = ["Ada", "Ben", "Cleo"];
  const participants = [];
  for (const name of names) {
    const participant = await newParticipant(browser, name, { name });
    participant.page.on("console", (m) => {
      if (m.type() === "error" && !m.text().includes("webpack-hmr")) {
        errors.push(`[${name}] ${m.text()}`);
      }
    });
    participant.page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
    await participant.context.addInitScript(DELAY_SDP, SDP_DELAY_MS);
    participants.push(participant);
  }
  const [host, ben, cleo] = participants;

  const roomUrl = await createRoomAsHost(host, BASE);
  await knockAndAdmit(host, ben, roomUrl, { timeout: 45_000 });
  await ensureCapacity(host, 3); // rooms start at 2; the third seat is deliberate
  await knockAndAdmit(host, cleo, roomUrl, { timeout: 45_000 });

  let connected = true;
  try {
    for (const participant of participants) {
      for (const name of names) {
        await waitForRosterName(participant.page, name, { timeout: 45_000 });
      }
      await waitForConnected(participant.page, { peers: 2, timeout: 60_000 });
    }
  } catch {
    connected = false;
  }
  check("the whole mesh connects even though candidates outran the SDP", connected);

  // The session catches this and renders it as a role=alert banner rather than
  // logging it, so the console alone is not enough to detect the bug -- collect
  // the banner text as well and assert over both.
  const banners = [];
  for (const participant of participants) {
    const alerts = await participant.page.locator('[role="alert"]').allInnerTexts();
    for (const text of alerts) banners.push(`[${participant.label}] ${text}`);
  }

  const iceFailures = [...errors, ...banners].filter((line) =>
    /addIceCandidate|remote description (is|was) null/i.test(line),
  );
  check(
    "no addIceCandidate failure surfaced on any link, in the console or the UI",
    iceFailures.length === 0,
    iceFailures.join(" | ") || undefined,
  );

  const negotiation = banners.filter((t) => /negotiation failed/i.test(t));
  check(
    "no participant shows a negotiation error banner",
    negotiation.length === 0,
    negotiation.join(" | ") || undefined,
  );

  // Every link must actually be usable in both directions, not merely
  // reported as connected: a note from each participant must reach both
  // others over the data channels.
  if (connected) {
    for (const participant of participants) await openNotes(participant.page);
    for (const sender of participants) {
      const text = `race survivor note from ${sender.name}`;
      await sendNote(sender.page, text);
      for (const receiver of participants) {
        if (receiver === sender) continue;
        let delivered = true;
        try {
          await receiver.page.getByText(text).first().waitFor({ timeout: 20_000 });
        } catch {
          delivered = false;
        }
        check(
          `link ${sender.name} -> ${receiver.name} works after the out-of-order negotiation`,
          delivered,
        );
      }
    }
  }

  mkdirSync("artifacts/screenshots", { recursive: true });
  writeFileSync("artifacts/screenshots/ice-race-host.png", await host.page.screenshot());

  if (errors.length > 0) {
    console.log("\n  Collected browser errors:");
    for (const line of errors.slice(0, 10)) console.log(`    ${line}`);
  }

  await Promise.all(participants.map((p) => p.context.close().catch(() => {})));
}

try {
  console.log(`Verifying the ICE/SDP ordering race (3-way mesh) against ${BASE}`);
  console.log(`  (holding every description POST back by ${SDP_DELAY_MS}ms, all participants)`);
  await run();
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await browser.close().catch(() => {});
}

console.log(
  `\n${state.failures === 0 ? "All ICE-race checks passed." : `${state.failures} check(s) failed.`} (${state.passes} passed, ${state.failures} failed, ${state.skips} skipped)`,
);
process.exit(state.failures === 0 ? 0 : 1);
