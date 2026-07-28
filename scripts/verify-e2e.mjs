/**
 * Drives two real Chromium contexts through a full session: pairing, notes,
 * file transfer, camera/mic, and the symmetric reset when one side leaves.
 *
 *   node scripts/verify-e2e.mjs [baseUrl] [--headed]
 *
 * Fake media devices are supplied by Chromium flags, so no hardware is needed.
 */

import { chromium } from "playwright";

const BASE = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://127.0.0.1:3111";
const HEADED = process.argv.includes("--headed");

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

const browser = await chromium.launch({
  headless: !HEADED,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

/** Each peer needs its own context so they don't share an origin's state. */
async function newPeer(label) {
  const context = await browser.newContext({
    permissions: ["camera", "microphone"],
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`  [${label}] page error: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    // Dev-server HMR sockets fail under 127.0.0.1; not our concern.
    if (message.type() === "error" && !text.includes("webpack-hmr")) {
      console.log(`  [${label}] console: ${text}`);
    }
  });
  return { context, page, label };
}

const status = (page) => page.locator('[data-slot="badge"][aria-live="polite"]');
const tab = (page, name) => page.getByRole("tab", { name });
const ROOM_URL = /\/room\/[0-9a-z-]+$/;

/**
 * Clicks until the URL changes. A click can land after first paint but before
 * React has attached its handlers, in which case it is silently swallowed.
 */
async function createSession(page) {
  const button = page.getByRole("button", { name: /create a private session/i });
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await button.click();
    try {
      await page.waitForURL(ROOM_URL, { timeout: 1500 });
      return page.url();
    } catch {
      if (attempt === 14) throw new Error("Create-session button never navigated");
    }
  }
}

async function run() {
  const a = await newPeer("A");
  const b = await newPeer("B");

  // ---------------------------------------------------------------- pairing
  console.log("\nCreating a session and pairing two browsers");
  await a.page.goto(BASE);
  const roomUrl = await createSession(a.page);

  await a.page.getByText(/waiting for one other person/i).waitFor({ timeout: 15_000 });
  check("creator lands in a lobby", true);
  check("session code is 16 chars from the safe alphabet", /\/room\/[0-9a-hjkmnp-tv-z]{16}$/.test(roomUrl), roomUrl);

  await b.page.goto(roomUrl);
  await status(a.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
  await status(b.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
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
  check(
    "the selected candidate pair is a direct route",
    ["host", "srflx", "prflx"].includes(pairType),
    `candidateType=${pairType}`,
  );

  // ------------------------------------------------------------------ notes
  console.log("\nNotes over the data channel");
  await tab(a.page, /notes/i).click();
  await tab(b.page, /notes/i).click();

  await a.page.getByLabel("Note", { exact: true }).fill("hello from A");
  await a.page.getByRole("button", { name: /send note/i }).click();
  await b.page.getByText("hello from A").waitFor({ timeout: 10_000 });
  check("A's note arrives at B", true);

  await b.page.getByLabel("Note", { exact: true }).fill("reply from B");
  await b.page.getByLabel("Note", { exact: true }).press("Enter");
  await a.page.getByText("reply from B").waitFor({ timeout: 10_000 });
  check("Enter sends, and B's reply arrives at A", true);
  check("composer clears after sending", (await b.page.getByLabel("Note", { exact: true }).inputValue()) === "");

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
  await tab(a.page, /files/i).click();
  await tab(b.page, /files/i).click();

  // ~700 KB spans many chunks and exercises the backpressure path.
  const payloadSize = 700 * 1024;
  await a.page.setInputFiles('input[type="file"]', {
    name: "payload.bin",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(payloadSize, 7),
  });

  await b.page.getByText("payload.bin").waitFor({ timeout: 20_000 });
  await b.page.getByText("Received").waitFor({ timeout: 40_000 });
  await a.page.getByText("Sent", { exact: true }).waitFor({ timeout: 40_000 });
  check("receiver reports the file as received", true);
  check("sender reports the file as sent", true);

  const saveLink = b.page.getByRole("link", { name: /save/i }).first();
  check("a download link is offered", await saveLink.isVisible());
  const href = await saveLink.getAttribute("href");
  check("the link points at an in-memory blob", Boolean(href?.startsWith("blob:")), href ?? "null");
  check(
    "the download keeps the original filename",
    (await saveLink.getAttribute("download")) === "payload.bin",
  );

  // Byte-for-byte integrity, read back from the blob the receiver assembled.
  const received = await b.page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
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
  await b.page.getByText("pixel.png").waitFor({ timeout: 15_000 });
  await b.page.locator('img[alt="pixel.png"]').waitFor({ timeout: 15_000 });
  check("an image preview is rendered for the receiver", true);

  // ------------------------------------------------------------------ media
  console.log("\nCamera, microphone and renegotiation");
  await tab(a.page, /audio & video|A\/V/i).click();
  await tab(b.page, /audio & video|A\/V/i).click();

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

  // Toggling a device must not tear the session down.
  await a.page.getByRole("button", { name: /turn off camera/i }).click();
  await b.page.getByText(/audio only/i).waitFor({ timeout: 25_000 });
  check("B sees the camera go away", true);
  check(
    "the session survives a device toggle",
    (await status(b.page).getByText("Peer connected").count()) === 1,
  );

  // ------------------------------------------------------------------ reset
  console.log("\nOne side leaves - both must reset");
  await b.page.getByRole("button", { name: /end session/i }).click();

  await b.page.getByText(/you ended the session/i).waitFor({ timeout: 15_000 });
  await a.page.getByText(/the other person ended the session/i).waitFor({ timeout: 25_000 });
  check("the leaver sees a terminal screen", true);
  check("the survivor is pushed to a terminal screen too", true);
  await status(a.page).getByText("Session ended").waitFor({ timeout: 10_000 });
  check("survivor's status badge reads ended", true);

  // The transcript must be gone on the surviving side, not merely hidden.
  check("the survivor's notes were cleared", (await a.page.getByText("hello from A").count()) === 0);
  check(
    "the survivor's transfers were cleared",
    (await a.page.getByText("payload.bin").count()) === 0,
  );
  const boundVideos = await a.page.evaluate(
    () => [...document.querySelectorAll("video")].filter((v) => v.srcObject).length,
  );
  check("no video element is still bound to a stream", boundVideos === 0, String(boundVideos));
  const liveTracks = await a.page.evaluate(() => Boolean(window.__instantPeerConnection));
  check("the peer connection was discarded", liveTracks === false);

  // The code must be dead, even for a browser that never saw the session live.
  const c = await newPeer("C");
  await c.page.goto(roomUrl);
  await c.page.getByText(/this session has already ended/i).waitFor({ timeout: 15_000 });
  check("a retired code refuses a fresh visitor", true);
  await c.context.close();
  await Promise.all([a.context.close(), b.context.close()]);

  // -------------------------------------------------- third-party exclusion
  console.log("\nA third participant cannot join a live session");
  const d = await newPeer("D");
  const e = await newPeer("E");
  const f = await newPeer("F");

  await d.page.goto(BASE);
  const liveRoom = await createSession(d.page);

  await e.page.goto(liveRoom);
  await status(d.page).getByText("Peer connected").waitFor({ timeout: 30_000 });
  await status(e.page).getByText("Peer connected").waitFor({ timeout: 30_000 });

  await f.page.goto(liveRoom);
  await f.page.getByText(/this session is already full/i).waitFor({ timeout: 15_000 });
  check("the third visitor is refused", true);
  check(
    "the established pair stays connected",
    (await status(d.page).getByText("Peer connected").count()) === 1 &&
      (await status(e.page).getByText("Peer connected").count()) === 1,
  );

  // ------------------------------------------------- unrecoverable disconnect
  console.log("\nClosing a tab resets the survivor");
  await e.context.close();
  await d.page.getByText(/the other person (ended the session|disconnected)/i).waitFor({
    timeout: 30_000,
  });
  check("the survivor resets when the peer's tab closes", true);

  await Promise.all([d.context.close(), f.context.close()]);
}

try {
  console.log(`Running end-to-end checks against ${BASE}`);
  await run();
} catch (error) {
  failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nAll end-to-end checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
