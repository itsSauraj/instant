/**
 * Drives two real Chromium contexts through a full session: pairing, notes,
 * file transfer, camera/mic, and the symmetric reset when one side leaves.
 *
 *   node scripts/verify-e2e.mjs [baseUrl] [--headed]
 *
 * --headed launches two visible, slowMo'd browser windows positioned side by
 * side so a human can watch both peers interact.
 *
 * Every meaningful state is captured as a PNG (both peers, light and dark
 * themes, desktop and mobile widths) under artifacts/screenshots/. The
 * directory is wiped at the start of each run so stale images never accumulate.
 *
 * Fake media devices are supplied by Chromium flags, so no hardware is needed.
 * Keep this file ASCII-only.
 */

import {
  MOBILE_VIEWPORT,
  SCREENSHOT_DIR,
  closeBrowsers,
  createSession,
  launchBrowsers,
  listScreenshots,
  makeChecker,
  newPeer,
  resetScreenshotDir,
  shot,
  statusBadge,
  tab,
  toggleTheme,
  parseCliArgs,
} from "./e2e-shared.mjs";

const { base: BASE, headed: HEADED } = parseCliArgs();
const { check, state } = makeChecker();

const browsers = await launchBrowsers({ headed: HEADED });
const peerOptions = { viewport: browsers.viewport };

async function run() {
  const a = await newPeer(browsers.left, "A", peerOptions); // host / initiator
  const b = await newPeer(browsers.right, "B", peerOptions); // guest / responder

  // ---------------------------------------------------------------- pairing
  console.log("\nCreating a session and pairing two browsers");
  await a.page.goto(BASE);
  await a.page.getByRole("button", { name: /create a private session/i }).waitFor({ timeout: 15_000 });
  await shot(a.page, "01-home.png");
  await toggleTheme(a.page);
  await shot(a.page, "01-home-light.png");
  await toggleTheme(a.page);

  const roomUrl = await createSession(a.page);

  await a.page.getByText(/waiting for one other person/i).waitFor({ timeout: 15_000 });
  check("creator lands in a lobby", true);
  check("session code is 16 chars from the safe alphabet", /\/room\/[0-9a-hjkmnp-tv-z]{16}$/.test(roomUrl), roomUrl);
  await shot(a.page, "02a-host-lobby.png");

  await b.page.goto(roomUrl);
  await shot(b.page, "02b-guest-joining.png");
  await statusBadge(a.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
  await statusBadge(b.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
  check("both sides report a connected peer", true);
  check("lobby overlay is gone", (await a.page.getByText(/waiting for one other/i).count()) === 0);

  // Confirm the route really is peer-to-peer rather than relayed.
  const pairType = await a.page.evaluate(async () => {
    const pc = window.__instantPeerConnection;
    if (!pc) return "unavailable";
    const stats = await pc.getStats();
    for (const report of stats.values()) {
      if (report.type === "candidate-pair" && report.state === "succeeded") {
        return stats.get(report.localCandidateId)?.candidateType ?? "unknown";
      }
    }
    return "none";
  });
  if (pairType === "unavailable") {
    // lib/peer-session.ts only exposes the connection handle outside production,
    // deliberately. Against a production build there is nothing to inspect, so
    // skip rather than fail - the check is a dev-time assurance, not a contract.
    console.log("  SKIP  candidate-pair inspection (no debug handle in a production build)");
  } else {
    check(
      "the selected candidate pair is a direct route",
      ["host", "srflx", "prflx"].includes(pairType),
      `candidateType=${pairType}`,
    );
  }

  // ------------------------------------------------------------------ notes
  console.log("\nNotes over the data channel");
  await tab(a.page, "notes").click();
  await tab(b.page, "notes").click();

  await a.page.getByLabel("Note", { exact: true }).fill("hello from A");
  await a.page.getByRole("button", { name: /send note/i }).click();
  await b.page.getByText("hello from A").waitFor({ timeout: 10_000 });
  check("A's note arrives at B", true);

  await b.page.getByLabel("Note", { exact: true }).fill("reply from B");
  await b.page.getByLabel("Note", { exact: true }).press("Enter");
  await a.page.getByText("reply from B").waitFor({ timeout: 10_000 });
  check("Enter sends, and B's reply arrives at A", true);
  check("composer clears after sending", (await b.page.getByLabel("Note", { exact: true }).inputValue()) === "");

  await shot(a.page, "03a-notes-host.png");
  await shot(b.page, "03b-notes-guest.png");
  await toggleTheme(a.page);
  await shot(a.page, "03c-notes-host-light.png");
  await toggleTheme(a.page);

  await b.page.getByLabel("Note", { exact: true }).fill("line one");
  await b.page.getByLabel("Note", { exact: true }).press("Shift+Enter");
  check(
    "Shift+Enter inserts a newline instead of sending",
    (await b.page.getByLabel("Note", { exact: true }).inputValue()).includes("\n"),
  );
  await b.page.getByLabel("Note", { exact: true }).fill("");

  await a.page.getByLabel("Note", { exact: true }).fill("about to send");
  await b.page.getByText(/typing/i).first().waitFor({ timeout: 8_000 });
  check("typing indicator reaches the peer", true);
  await a.page.getByLabel("Note", { exact: true }).fill("");

  // ------------------------------------------------------------------ files
  console.log("\nFile transfer over the data channel");
  await tab(a.page, "files").click();
  await tab(b.page, "files").click();

  // ~700 KB spans many chunks and exercises the backpressure path.
  const payloadSize = 700 * 1024;
  await a.page.setInputFiles('input[type="file"]', {
    name: "payload.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(payloadSize, 7),
  });

  await b.page.getByText("payload.bin").first().waitFor({ timeout: 20_000 });
  await shot(b.page, "04-file-transfer-progress.png");
  await b.page.getByText("Received").first().waitFor({ timeout: 40_000 });
  await a.page.getByText("Sent", { exact: true }).first().waitFor({ timeout: 40_000 });
  check("receiver reports the file as received", true);
  check("sender reports the file as sent", true);
  await shot(b.page, "05-file-received.png");

  const saveLink = b.page.getByRole("link", { name: /save/i }).first();
  check("a download link is offered", await saveLink.isVisible());
  const href = await saveLink.getAttribute("href");
  check("the link points at an in-memory blob", Boolean(href?.startsWith("blob:")), href ?? "null");
  check(
    "the download keeps the original filename",
    (await saveLink.getAttribute("download")) === "payload.bin",
  );

  // Byte-for-byte integrity, read back from the blob the receiver assembled.
  // fetch(blob:) is refused by the CSP's connect-src, so the bytes come from
  // the createObjectURL registry installed by the shared init script.
  const received = await b.page.evaluate(async (url) => {
    const blob = window.__blobRegistry?.get(url);
    if (!blob) return { size: -1, sum: -1, first: -1, last: -1 };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let sum = 0;
    for (const byte of bytes) sum += byte;
    return { size: bytes.byteLength, sum, first: bytes[0], last: bytes[bytes.length - 1] };
  }, href);
  check("reassembled size matches exactly", received.size === payloadSize, String(received.size));
  check(
    "every reassembled byte matches",
    received.sum === payloadSize * 7 && received.first === 7 && received.last === 7,
    JSON.stringify(received),
  );

  // An image also builds a preview thumbnail.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
    "base64",
  );
  await a.page.setInputFiles('input[type="file"]', {
    name: "pixel.png",
    mimeType: "image/png",
    buffer: png,
  });
  await b.page.getByText("pixel.png").first().waitFor({ timeout: 15_000 });
  await b.page.locator('img[alt="pixel.png"]').waitFor({ timeout: 15_000 });
  check("an image preview is rendered for the receiver", true);

  // ------------------------------------------------------------------ media
  console.log("\nCamera, microphone and renegotiation");
  await tab(a.page, "media").click();
  await tab(b.page, "media").click();

  await a.page.getByRole("button", { name: /turn on microphone/i }).click();
  await b.page.getByText(/receiving audio/i).waitFor({ timeout: 30_000 });
  check("B receives A's audio track after renegotiation", true);

  await a.page.getByRole("button", { name: /turn on camera/i }).click();
  await b.page.waitForFunction(
    () => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0),
    undefined,
    { timeout: 30_000 },
  );
  check("B renders live video frames from A", true);
  await shot(b.page, "06-video-connected.png");

  // Toggling a device must not tear the session down.
  await a.page.getByRole("button", { name: /turn off camera/i }).click();
  await b.page.getByText(/audio only/i).waitFor({ timeout: 25_000 });
  check("B sees the camera go away", true);
  check(
    "the session survives a device toggle",
    (await statusBadge(b.page).getByText("Peer connected").count()) === 1,
  );

  // ------------------------------------------------- host panel (if present)
  // Worker 1 is landing host authority concurrently; only screenshot the panel
  // when it exists. Its absence is not a failure.
  const hostPanel = a.page
    .locator('section[aria-label="Host controls"], [data-slot="host-panel"], [data-testid="host-panel"]')
    .or(a.page.getByText(/guest can end|only you can end/i))
    .first();
  if (await hostPanel.isVisible().catch(() => false)) {
    await shot(a.page, "07-host-panel.png");
  } else {
    console.log("  NOTE  host panel not present; skipping 07-host-panel.png");
  }

  // ------------------------------------------------------------------ reset
  // The HOST ends the session: valid under both the original rule (either side
  // may end) and the host-authority rule (only the host may, until granted).
  console.log("\nThe host ends the session - both sides must reset");
  await a.page.getByRole("button", { name: /end session/i }).click();

  await a.page.getByText(/you ended the session/i).waitFor({ timeout: 15_000 });
  check("the leaver sees a terminal screen", true);

  await b.page.locator('[role="alertdialog"]').waitFor({ timeout: 25_000 });
  check("the survivor is pushed to a terminal screen too", true);
  // The survivor must be told the end was DELIBERATE. There is a live race
  // where the ender's data-channel teardown outruns the server's "peer-ended"
  // event, so the survivor sees "disconnected" instead; keep this strict so
  // the defect stays visible, but do not abort the rest of the run on it.
  const survivorText = (
    await b.page.locator('[role="alertdialog"]').innerText()
  ).replace(/\s+/g, " ");
  check(
    'the survivor is told the end was deliberate ("ended", not "disconnected")',
    /the other person ended the session/i.test(survivorText),
    `observed: ${survivorText.slice(0, 160)}`,
  );
  await statusBadge(b.page).getByText("Session ended").waitFor({ timeout: 10_000 });
  check("survivor's status badge reads ended", true);
  await shot(a.page, "08a-ended-host.png");
  await shot(b.page, "08b-ended-guest.png");

  // The transcript must be gone on the surviving side, not merely hidden.
  check("the survivor's notes were cleared", (await b.page.getByText("hello from A").count()) === 0);
  check(
    "the survivor's transfers were cleared",
    (await b.page.getByText("payload.bin").count()) === 0,
  );
  const boundVideos = await b.page.evaluate(
    () => [...document.querySelectorAll("video")].filter((v) => v.srcObject).length,
  );
  check("no video element is still bound to a stream", boundVideos === 0, String(boundVideos));
  const liveTracks = await b.page.evaluate(() => Boolean(window.__instantPeerConnection));
  check("the peer connection was discarded", liveTracks === false);

  // The code must be dead, even for a browser that never saw the session live.
  const c = await newPeer(browsers.right, "C", peerOptions);
  await c.page.goto(roomUrl);
  await c.page.getByText(/this session has already ended/i).waitFor({ timeout: 15_000 });
  check("a retired code refuses a fresh visitor", true);
  await c.context.close();
  await Promise.all([a.context.close(), b.context.close()]);

  // -------------------------------------------------- third-party exclusion
  console.log("\nA third participant cannot join a live session");
  const d = await newPeer(browsers.left, "D", peerOptions);
  const e = await newPeer(browsers.right, "E", peerOptions);
  const f = await newPeer(browsers.right, "F", peerOptions);

  await d.page.goto(BASE);
  const liveRoom = await createSession(d.page);

  await e.page.goto(liveRoom);
  await statusBadge(d.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
  await statusBadge(e.page).getByText("Peer connected").waitFor({ timeout: 30_000 });

  await f.page.goto(liveRoom);
  await f.page.getByText(/this session is already full/i).waitFor({ timeout: 15_000 });
  check("the third visitor is refused", true);
  await shot(f.page, "09-third-party-refused.png");
  check(
    "the established pair stays connected",
    (await statusBadge(d.page).getByText("Peer connected").count()) === 1 &&
      (await statusBadge(e.page).getByText("Peer connected").count()) === 1,
  );

  // ------------------------------------------------- unrecoverable disconnect
  console.log("\nClosing a tab resets the survivor");
  await e.context.close();
  await d.page.getByText(/the other person (ended the session|disconnected)/i).waitFor({
    timeout: 30_000,
  });
  check("the survivor resets when the peer's tab closes", true);

  // ------------------------------------------------------------- not found
  console.log("\nAn invalid session code routes to not-found");
  await f.page.goto(`${BASE}/room/invalid`);
  await f.page.getByText(/session code isn/i).waitFor({ timeout: 15_000 });
  check("an invalid code shows the not-found screen", true);
  await shot(f.page, "10-not-found.png");

  await Promise.all([d.context.close(), f.context.close()]);
}

async function runMobile() {
  console.log("\nMobile-width pass (390x844)");
  const host = await newPeer(browsers.left, "M1", { viewport: MOBILE_VIEWPORT });
  const guest = await newPeer(browsers.right, "M2", { viewport: MOBILE_VIEWPORT });

  await host.page.goto(BASE);
  await host.page
    .getByRole("button", { name: /create a private session/i })
    .waitFor({ timeout: 15_000 });
  await shot(host.page, "mobile-01-home.png");

  const roomUrl = await createSession(host.page);
  await host.page.getByText(/waiting for one other person/i).waitFor({ timeout: 15_000 });
  await shot(host.page, "mobile-02-lobby.png");

  await guest.page.goto(roomUrl);
  await statusBadge(host.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
  await statusBadge(guest.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
  check("mobile pair connects", true);

  await tab(host.page, "notes").click();
  await host.page.getByLabel("Note", { exact: true }).fill("note from a phone");
  await host.page.getByLabel("Note", { exact: true }).press("Enter");
  await guest.page.getByText("note from a phone").waitFor({ timeout: 10_000 });
  check("notes work at mobile width", true);
  await shot(guest.page, "mobile-03-notes.png");

  await tab(guest.page, "files").click();
  await shot(guest.page, "mobile-04-files.png");

  // The Audio & video tab collapses to "A/V" at this width; the shared tab
  // locator tolerates both labels.
  await tab(guest.page, "media").click();
  check("the collapsed A/V tab is clickable at mobile width", true);
  await shot(guest.page, "mobile-05-av.png");

  await Promise.all([host.context.close(), guest.context.close()]);
}

try {
  console.log(`Running end-to-end checks against ${BASE}${HEADED ? " (headed, slowMo)" : ""}`);
  await resetScreenshotDir();
  await run();
  await runMobile();
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await closeBrowsers(browsers);
}

const shots = await listScreenshots();
console.log(`\nScreenshots: ${shots.length} image(s) written to ${SCREENSHOT_DIR}`);
for (const name of shots) console.log(`  ${name}`);

console.log(
  state.failures === 0
    ? `\nAll ${state.passes} end-to-end checks passed.`
    : `\n${state.failures} check(s) failed (${state.passes} passed).`,
);
process.exit(state.failures === 0 ? 0 : 1);
