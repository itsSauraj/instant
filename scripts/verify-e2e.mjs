/**
 * Deep two-person feature pass under the Phase 1 mesh model: knock/admit
 * pairing, notes, file transfer with byte-level integrity, camera/mic and
 * renegotiation, the host's deliberate close (with the right wording on the
 * survivor), capacity refusal for a third visitor, and a mobile-width run.
 *
 *   node scripts/verify-e2e.mjs [baseUrl] [--headed]
 *
 * The wider 3-up and 5-up mesh choreography lives in verify-mesh-e2e.mjs;
 * this suite goes deep on the features a pair actually uses. Screenshots are
 * APPENDED to artifacts/screenshots/ (verify-mesh-e2e.mjs owns the wipe).
 *
 * Selector contract: scripts/mesh-shared.mjs. Keep this file ASCII-only.
 */

import {
  MOBILE_VIEWPORT,
  SCREENSHOT_DIR,
  askToJoinButton,
  closeParticipantsIfOpen,
  closeRoomAsHost,
  containsSpuriousError,
  createRoomAsHost,
  describesDeliberateClose,
  ensureScreenshotDir,
  knockAndAdmit,
  launchMeshBrowser,
  listScreenshots,
  makeChecker,
  nameGateField,
  newParticipant,
  openNotes,
  parseCliArgs,
  rosterText,
  sendNote,
  shot,
  terminalText,
  wait,
  waitForConnected,
  waitForRosterName,
} from "./mesh-shared.mjs";

const { base: BASE, headed: HEADED } = parseCliArgs();
const { check, skip, state } = makeChecker();

const browser = await launchMeshBrowser({ headed: HEADED });

/** Tab labels collapse on small screens ("Audio & video" renders as "A/V").
 * Clicking first clears the participants panel's scrim, which otherwise
 * swallows the click. */
const TAB_NAMES = {
  notes: /notes/i,
  files: /files/i,
  media: /audio & video|a\/v/i,
};
const tab = (page, key) => ({
  async click() {
    await closeParticipantsIfOpen(page);
    await page.getByRole("tab", { name: TAB_NAMES[key] ?? key }).first().click();
  },
});

const isDark = (page) =>
  page.evaluate(() => document.documentElement.classList.contains("dark"));

async function toggleTheme(page) {
  const before = await isDark(page);
  await page.locator('button[aria-label^="Switch to"]').first().click();
  await page.waitForFunction(
    (was) => document.documentElement.classList.contains("dark") !== was,
    before,
    { timeout: 5000 },
  );
  return !before;
}

async function pair(host, guest) {
  const roomUrl = await createRoomAsHost(host, BASE);
  await knockAndAdmit(host, guest, roomUrl);
  await waitForRosterName(host.page, guest.name);
  await waitForRosterName(guest.page, host.name);
  await waitForConnected(host.page, { peers: 1 });
  await waitForConnected(guest.page, { peers: 1 });
  return roomUrl;
}

async function run() {
  const a = await newParticipant(browser, "A", { name: "Ada" });
  const b = await newParticipant(browser, "B", { name: "Ben" });

  // ---------------------------------------------------------------- pairing
  console.log("\nCreating a room and admitting one guest");
  await a.page.goto(BASE);
  await a.page
    .getByRole("button", { name: /create a private session|create/i })
    .first()
    .waitFor({ timeout: 15_000 });
  await shot(a.page, "pair-01-home.png");
  await toggleTheme(a.page);
  await shot(a.page, "pair-01-home-light.png");
  await toggleTheme(a.page);

  const roomUrl = await pair(a, b);
  check(
    "session code is 8 chars from the safe alphabet",
    /\/room\/[0-9a-hjkmnp-tv-z]{8}(?:[/?#]|$)/.test(roomUrl),
    roomUrl,
  );
  check("host and guest see each other in the roster", true);
  await shot(a.page, "pair-02-connected.png");

  // Confirm the route really is peer-to-peer rather than relayed. The debug
  // handle's exact shape depends on the in-flight transport rewrite, so probe
  // the plausible names and skip when absent (production builds hide it).
  const pairType = await a.page.evaluate(async () => {
    const single = window.__instantPeerConnection;
    const many = window.__instantPeerConnections ?? window.__instantMeshConnections;
    const pcs = single
      ? [single]
      : many
        ? Array.from(typeof many.values === "function" ? many.values() : Object.values(many))
        : [];
    if (pcs.length === 0) return "unavailable";
    for (const pc of pcs) {
      const stats = await pc.getStats();
      for (const report of stats.values()) {
        if (report.type === "candidate-pair" && report.state === "succeeded") {
          return stats.get(report.localCandidateId)?.candidateType ?? "unknown";
        }
      }
    }
    return "none";
  });
  if (pairType === "unavailable") {
    skip(
      "candidate-pair inspection",
      "no debug handle exposed (production build, or the transport has not shipped one yet)",
    );
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

  // Fill-and-click as one retried unit: a dev-server Fast Refresh between the
  // two steps resets the composer state and leaves Send disabled.
  {
    const composer = a.page.getByLabel("Note", { exact: true });
    const send = a.page.getByRole("button", { name: /send note/i });
    let sent = false;
    for (let attempt = 0; attempt < 5 && !sent; attempt += 1) {
      await composer.fill("hello from Ada");
      sent = await send
        .click({ timeout: 4000 })
        .then(() => true)
        .catch(() => false);
    }
    if (!sent) throw new Error("Send note button never became clickable");
  }
  await b.page.getByText("hello from Ada").waitFor({ timeout: 10_000 });
  check("A's note arrives at B", true);

  await b.page.getByLabel("Note", { exact: true }).fill("reply from Ben");
  await b.page.getByLabel("Note", { exact: true }).press("Enter");
  await a.page.getByText("reply from Ben").waitFor({ timeout: 10_000 });
  check("Enter sends, and B's reply arrives at A", true);
  // The composer is a rich-text field (contenteditable), so its content is
  // read as text rather than as an input value. Such fields keep trailing
  // spaces as U+00A0; normalise those to plain spaces.
  const composerText = async (page) =>
    (await page.getByLabel("Note", { exact: true }).innerText()).replace(/ /g, " ");
  check("composer clears after sending", (await composerText(b.page)).trim() === "");

  await shot(a.page, "pair-03-notes.png");

  await b.page.getByLabel("Note", { exact: true }).fill("line one");
  await b.page.getByLabel("Note", { exact: true }).press("Shift+Enter");
  await b.page.getByLabel("Note", { exact: true }).pressSequentially("line two");
  check(
    "Shift+Enter inserts a newline instead of sending",
    /line one\s*\n\s*line two/.test(await composerText(b.page)) &&
      !(await a.page.getByText("line one").isVisible().catch(() => false)),
  );
  await b.page.getByLabel("Note", { exact: true }).fill("");

  // Formatting renders as you type: the markers disappear and the text is
  // bold in the field itself, then arrives bold on the other side.
  await b.page.getByLabel("Note", { exact: true }).pressSequentially("this is **loud** text");
  const liveBold = b.page.getByLabel("Note", { exact: true }).locator("strong");
  check(
    "typing **bold** renders bold in the composer, without the markers",
    (await liveBold.count()) === 1 &&
      (await liveBold.first().innerText()) === "loud" &&
      !(await composerText(b.page)).includes("**"),
    await composerText(b.page),
  );
  await b.page.getByLabel("Note", { exact: true }).press("Enter");
  await a.page.locator('[data-slot="note"] strong', { hasText: "loud" }).first().waitFor({
    timeout: 10_000,
  });
  check("the bold note arrives rendered bold at the other side", true);

  // A fence opens a code block on the spot, the block carries a language
  // picker, and the note arrives as a highlighted block in that language.
  await b.page.getByLabel("Note", { exact: true }).pressSequentially("```");
  const liveCode = b.page.getByLabel("Note", { exact: true }).locator("pre code");
  await liveCode.first().waitFor({ timeout: 5000 }).catch(() => {});
  check("typing ``` opens a code block in the composer", (await liveCode.count()) === 1);
  await b.page.getByLabel("Note", { exact: true }).pressSequentially("print('hi')");
  const picker = b.page.getByRole("combobox", { name: "Code language" });
  check("the code block offers a language picker", await picker.isVisible().catch(() => false));
  await picker.click();
  await b.page.getByRole("option", { name: "Python", exact: true }).click();
  check(
    "picking a language updates the picker",
    /python/i.test(await picker.innerText().catch(() => "")),
  );
  await b.page.getByLabel("Note", { exact: true }).press("Control+Enter");
  const receivedCode = a.page.locator('[data-slot="note"] pre code', { hasText: "print" }).first();
  await receivedCode.waitFor({ timeout: 10_000 });
  check(
    "the code block arrives as a block tagged with its language",
    /language-python/.test((await receivedCode.getAttribute("class")) ?? ""),
    await receivedCode.getAttribute("class"),
  );

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
  await b.page.getByText("Received").first().waitFor({ timeout: 40_000 });
  await a.page.getByText("Sent", { exact: true }).first().waitFor({ timeout: 40_000 });
  check("receiver reports the file as received", true);
  check("sender reports the file as sent", true);
  await shot(b.page, "pair-04-file-received.png");

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
  await b.page.getByText(/receiving audio|audio/i).first().waitFor({ timeout: 30_000 });
  check("B is told about A's audio track after renegotiation", true);

  await a.page.getByRole("button", { name: /turn on camera/i }).click();
  await b.page.waitForFunction(
    () => [...document.querySelectorAll("video")].some((v) => v.videoWidth > 0),
    undefined,
    { timeout: 30_000 },
  );
  check("B renders live video frames from A", true);
  await shot(b.page, "pair-05-video.png");

  // Toggling a device must not tear the session down.
  await a.page.getByRole("button", { name: /turn off camera/i }).click();
  await b.page.waitForFunction(
    () => ![...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused),
    undefined,
    { timeout: 30_000 },
  );
  check("B sees the camera go away", true);
  const rosterAfterToggle = await rosterText(b.page);
  check(
    "the session survives a device toggle",
    rosterAfterToggle.includes("Ada"),
    rosterAfterToggle.slice(0, 160),
  );

  // ------------------------------------------------------------------ close
  console.log("\nThe host closes -- the survivor must hear it was deliberate");
  await closeRoomAsHost(a);

  const hostText = await terminalText(a.page).catch(() => null);
  check(
    "the closer sees a terminal screen",
    typeof hostText === "string",
    hostText ?? "no terminal overlay",
  );
  const survivorText = await terminalText(b.page).catch(() => null);
  check(
    "the survivor is pushed to a terminal screen too",
    typeof survivorText === "string",
    survivorText ?? "no terminal overlay",
  );
  if (typeof survivorText === "string") {
    // The end-reason wording contract: a deliberate close must never be
    // reported as a disconnect. This closed a real bug; keep it strict.
    check(
      'the survivor is told the end was DELIBERATE ("closed/ended", not "disconnected")',
      describesDeliberateClose(survivorText),
      `observed: ${survivorText.slice(0, 160)}`,
    );
    check(
      "the survivor sees no spurious transport error on a clean close",
      !containsSpuriousError(survivorText),
      `observed: ${survivorText.slice(0, 160)}`,
    );
  }
  await shot(a.page, "pair-06a-ended-host.png");
  await shot(b.page, "pair-06b-ended-guest.png");

  // The transcript must be gone on the surviving side, not merely hidden.
  check("the survivor's notes were cleared", (await b.page.getByText("hello from Ada").count()) === 0);
  check(
    "the survivor's transfers were cleared",
    (await b.page.getByText("payload.bin").count()) === 0,
  );
  const boundVideos = await b.page.evaluate(
    () => [...document.querySelectorAll("video")].filter((v) => v.srcObject).length,
  );
  check("no video element is still bound to a stream", boundVideos === 0, String(boundVideos));

  await Promise.all([a.context.close(), b.context.close()]);

  // -------------------------------------------------- third-party refusal
  console.log("\nAt default capacity 2, a third visitor is refused room-full");
  const d = await newParticipant(browser, "D", { name: "Dinah" });
  const e = await newParticipant(browser, "E", { name: "Emil" });
  const f = await newParticipant(browser, "F", { name: "Fern" });

  const liveRoom = await pair(d, e);

  // The third visitor still passes the name gate; the refusal comes when
  // their knock actually reaches the full room.
  await f.page.goto(liveRoom);
  const fGate = nameGateField(f.page);
  await fGate.waitFor({ timeout: 15_000 });
  await fGate.fill(f.name);
  await askToJoinButton(f.page).click();
  await f.page.getByText(/full/i).first().waitFor({ timeout: 20_000 });
  check("the third visitor is told the room is full", true);
  await shot(f.page, "pair-07-third-refused.png");
  const dRoster = await rosterText(d.page);
  const eRoster = await rosterText(e.page);
  check(
    "the established pair stays connected",
    dRoster.includes("Emil") && eRoster.includes("Dinah"),
  );

  // --------------------------------------------- dropped tab holds the seat
  console.log("\nClosing a tab marks the peer away -- the room survives");
  await e.context.close();
  let sawAway = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = await rosterText(d.page);
    if (text.includes("Emil") && /away|reconnect/i.test(text)) {
      sawAway = true;
      break;
    }
    await wait(300);
  }
  check(
    "the survivor sees the peer held as away, not instantly gone",
    sawAway,
    (await rosterText(d.page)).slice(0, 200),
  );
  const dEnded = await d.page.locator('[role="alertdialog"]').isVisible().catch(() => false);
  check("the room did NOT end when the tab closed", !dEnded);
  skip(
    "the away seat is released as \"disconnected\" after the grace window",
    "requires waiting the real awayTtlMs (45s)",
  );

  // ------------------------------------------------------------- not found
  console.log("\nAn invalid session code routes to not-found");
  await f.page.goto(`${BASE}/room/invalid`);
  await f.page.getByText(/session code isn|not.*valid|invalid/i).first().waitFor({ timeout: 15_000 });
  check("an invalid code shows the not-found screen", true);
  await shot(f.page, "pair-08-not-found.png");

  await Promise.all([d.context.close(), f.context.close()]);
}

async function runMobile() {
  console.log("\nMobile-width pass (390x844)");
  const host = await newParticipant(browser, "M1", { name: "Mika", viewport: MOBILE_VIEWPORT });
  const guest = await newParticipant(browser, "M2", { name: "Noor", viewport: MOBILE_VIEWPORT });

  await host.page.goto(BASE);
  await host.page
    .getByRole("button", { name: /create a private session|create/i })
    .first()
    .waitFor({ timeout: 15_000 });
  await shot(host.page, "pair-mobile-01-home.png");

  const roomUrl = await createRoomAsHost(host, BASE);
  await shot(host.page, "pair-mobile-02-room.png");

  await knockAndAdmit(host, guest, roomUrl);
  await waitForRosterName(guest.page, "Mika");
  check("mobile pair connects via knock/admit", true);

  await tab(host.page, "notes").click();
  await sendNote(host.page, "note from a phone");
  await guest.page.getByText("note from a phone").waitFor({ timeout: 10_000 });
  check("notes work at mobile width", true);
  await shot(guest.page, "pair-mobile-03-notes.png");

  await tab(guest.page, "files").click();
  await shot(guest.page, "pair-mobile-04-files.png");

  await tab(guest.page, "media").click();
  check("the collapsed A/V tab is clickable at mobile width", true);
  await shot(guest.page, "pair-mobile-05-av.png");

  await Promise.all([host.context.close(), guest.context.close()]);
}

try {
  console.log(`Running end-to-end checks against ${BASE}${HEADED ? " (headed)" : ""}`);
  await ensureScreenshotDir();
  await run();
  await runMobile();
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await browser.close().catch(() => {});
}

const shots = await listScreenshots();
console.log(`\nScreenshots: ${shots.length} image(s) under ${SCREENSHOT_DIR}`);

console.log(
  `\n${state.failures === 0 ? "All end-to-end checks passed." : `${state.failures} check(s) failed.`} (${state.passes} passed, ${state.failures} failed, ${state.skips} skipped)`,
);
process.exit(state.failures === 0 ? 0 : 1);
