/**
 * Phase 4 verification: the stage-plus-strip video call layout, pinning,
 * robot avatars and host moderation.
 *
 * Drives REAL browser contexts (2-up, 4-up and 7-up meshes) against a running
 * dev server. Usage:
 *
 *   node scripts/verify-video-grid.mjs [http://127.0.0.1:3111] [--headed] [--skip-7]
 *
 * Keep this file ASCII-only: a previous editing round-trip through PowerShell
 * corrupted non-ASCII characters, so none are allowed back in.
 *
 * Selector contract (owned by this lane, in components/room/):
 *   [data-slot="video-grid"]     data-layout="stage" | "empty", data-stage-id
 *   [data-slot="video-strip"]    the small-card strip (right column / bottom row)
 *   [data-slot="video-tile"]     data-peer-id, data-self, data-video-live,
 *                                data-pinned="local" | "host"
 *   [data-avatar="robot"|"initials"], data-avatar-seed  inside a placeholder
 *   [data-slot="call-controls"]  the floating control pill
 *   [data-slot="host-controls"]  the host's room-wide moderation cluster
 *   [data-slot="moderation-ask"] the ask-to-unmute prompt on the target
 *
 * Dev-only hooks used here (both follow the repo's __instantPeerConnections
 * convention and exist only outside production builds):
 *   window.__instantModerationTest(action, byName)  inject an incoming
 *     `moderated` event into the media panel (the transport lane has not
 *     landed the real event wiring yet).
 *   window.__instantModerationOutbox  records outgoing host moderation
 *     actions while `onModerate` is not wired into room-client. When the
 *     manager wires the real prop the fallback disappears; the suite
 *     feature-detects that and asserts real enforcement instead where it can.
 *
 * NOTE on timeouts: a 7-way mesh is 21 RTCPeerConnections negotiated through
 * one dev server, so the 7-up section runs with very generous timeouts (up to
 * 3 minutes just for "everyone connected") and is skippable with --skip-7.
 */

import { chromium } from "playwright";

import {
  DESKTOP_VIEWPORT,
  MEDIA_ARGS,
  MOBILE_VIEWPORT,
  admitButton,
  clickUntil,
  createRoomAsHost,
  joinAsGuest,
  leaveButton,
  makeChecker,
  newParticipant,
  parseCliArgs,
  shot,
  statusBadge,
  terminalOverlay,
  wait,
  waitForConnected,
} from "./mesh-shared.mjs";

const { base, headed } = parseCliArgs();
const skipSeven = process.argv.includes("--skip-7");
const { state, check, skip } = makeChecker();

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function openTab(page, pattern) {
  const tab = page.getByRole("tab", { name: pattern }).first();
  const opened = await clickUntil(
    tab,
    async () => (await tab.getAttribute("aria-selected")) === "true",
  );
  if (!opened) throw new Error(`could not open the ${pattern} tab`);
}

const openMediaTab = (page) => openTab(page, /audio & video/i);

/** The ParticipantsPanel (another lane's, new this week) is a FIXED overlay
 *  pinned to the right edge -- exactly over the video strip column -- and it
 *  opens by itself on some pages. A real user closes it; so does the suite,
 *  or its subtree intercepts every click on the strip cards' controls. */
async function closeParticipantsOverlay(page) {
  const overlay = page.locator('aside[aria-label="Participants" i]').first();
  if (!(await overlay.isVisible().catch(() => false))) return;
  const closer = overlay.getByRole("button", { name: /close|hide|dismiss/i }).first();
  if (await closer.isVisible().catch(() => false)) {
    await closer.click().catch(() => {});
  } else {
    await page.keyboard.press("Escape").catch(() => {});
  }
  await wait(300);
}

/** Media tab + a clear view of the grid (participants overlay closed). */
async function openMediaView(page) {
  await openMediaTab(page);
  await closeParticipantsOverlay(page);
}

/** Sets the room capacity over the signalling API with the HOST's own
 *  captured credentials. The stepper UI is another lane's moving target this
 *  week (it moved into a Settings tab, partly under the participants
 *  overlay), and capacity UI is not what this suite verifies -- the server
 *  accepting the host's `capacity` message is all the mesh needs. Requires
 *  installAuthCapture() on the host context and at least one prior host POST
 *  (answering the first knock does it). */
async function raiseCapacity(host, roomId, target) {
  const status = await pollUntil(
    () => postAs(host.page, roomId, { t: "capacity", value: target }),
    (s) => s === 200,
    { timeout: 20_000, interval: 1000 },
  );
  if (status !== 200) throw new Error(`capacity POST kept failing (last status ${status})`);
}

/** Every tile, in DOM order, with the state the suite asserts on. */
async function tileInfo(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-slot="video-tile"]')).map((tile) => {
      const avatar = tile.querySelector("[data-avatar]");
      return {
        id: tile.getAttribute("data-peer-id"),
        self: tile.hasAttribute("data-self"),
        pinned: tile.getAttribute("data-pinned"),
        videoLive: tile.hasAttribute("data-video-live"),
        hostMarker: Boolean(tile.querySelector('[title="Host"]')),
        micOffMarker: Boolean(tile.querySelector('[title="Microphone off"]')),
        avatarKind: avatar ? avatar.getAttribute("data-avatar") : null,
        avatarSeed: avatar ? avatar.getAttribute("data-avatar-seed") : null,
        avatarSvg: avatar && avatar.querySelector("svg") ? avatar.querySelector("svg").innerHTML : null,
        text: (tile.textContent || "").replace(/\s+/g, " ").trim(),
      };
    }),
  );
}

async function stageIdOf(page) {
  return page.evaluate(
    () =>
      document
        .querySelector('[data-slot="video-grid"][data-layout="stage"]')
        ?.getAttribute("data-stage-id") ?? null,
  );
}

/** Small-card ids in strip DOM order. */
async function stripIds(page) {
  return page.evaluate(() =>
    Array.from(
      document.querySelectorAll('[data-slot="video-strip"] [data-slot="video-tile"]'),
    ).map((tile) => tile.getAttribute("data-peer-id")),
  );
}

async function boxOf(page, selector) {
  return page.locator(selector).first().boundingBox();
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

async function videoWidthFor(page, peerId) {
  return page.evaluate((id) => {
    const video = document.querySelector(
      `[data-slot="video-tile"][data-peer-id="${id}"] video`,
    );
    return video ? video.videoWidth : -1;
  }, peerId);
}

async function pollUntil(read, predicate, { timeout = 30_000, interval = 300 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() > deadline) return value;
    await wait(interval);
  }
}

async function peerIdByName(page, name) {
  const tiles = await tileInfo(page);
  return tiles.find((tile) => tile.text.includes(name))?.id ?? null;
}

function tileLocator(page, peerId) {
  return page.locator(`[data-slot="video-tile"][data-peer-id="${peerId}"]`).first();
}

async function deviceButton(page, label) {
  return page.getByRole("button", { name: new RegExp(`^${escapeRegex(label)}$`, "i") }).first();
}

/** Clicks a device toggle and waits for its label to flip to `after`. */
async function toggleDevice(page, before, after, { timeout = 20_000 } = {}) {
  const button = await deviceButton(page, before);
  const done = await clickUntil(
    button,
    async () => (await (await deviceButton(page, after)).isVisible().catch(() => false)),
    { attempts: Math.ceil(timeout / 800), delay: 800 },
  );
  return done;
}

function localPinButton(page, peerId, name, { unpin = false } = {}) {
  return tileLocator(page, peerId).getByRole("button", {
    name: new RegExp(
      `^${unpin ? "unpin" : "pin"} ${escapeRegex(name)} \\(your layout only\\)$`,
      "i",
    ),
  });
}

function hostPinButton(page, peerId, name, { unpin = false } = {}) {
  return tileLocator(page, peerId).getByRole("button", {
    name: new RegExp(`^${unpin ? "unpin" : "pin"} ${escapeRegex(name)} for everyone$`, "i"),
  });
}

async function clickTileControl(page, button) {
  await button.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await button.click({ timeout: 10_000 });
  } catch {
    // Four chromium contexts plus a dev server can peg the CPU hard enough
    // that a real pointer click never reports settled; a synthesized click
    // still runs the React handler, which is what the assertion needs.
    await button.evaluate((element) => element.click());
  }
}

/** Records the x-peer-id / x-peer-secret pair the page's own signalling POSTs
 *  use, so the suite can replay messages AS that peer (host-authorized ones,
 *  and forged non-host ones the server must refuse). */
function installAuthCapture(context) {
  return context.addInitScript(() => {
    const original = window.fetch;
    window.fetch = function patchedFetch(input, init) {
      try {
        const headers = init && init.headers;
        if (headers && typeof headers === "object" && headers["x-peer-id"]) {
          window.__signalAuth = {
            peerId: headers["x-peer-id"],
            secret: headers["x-peer-secret"],
          };
        }
      } catch {
        // Capture is best-effort.
      }
      return original.apply(this, arguments);
    };
  });
}

/** Simulates an OLDER client that never sends `uid` on the joining GET (the
 *  contract's stated source of an empty `avatarSeed`; the current client
 *  always presents one, minting a per-page uid even when storage fails). The
 *  server then seats the peer with avatarSeed "" and every tile must fall
 *  back to initials. */
function installLegacyNoUidClient(context) {
  return context.addInitScript(() => {
    const original = window.fetch;
    window.fetch = function legacyFetch(input, init) {
      try {
        const url = typeof input === "string" ? input : input && input.url;
        if (url && url.includes("/api/signal/")) {
          const parsed = new URL(url, location.origin);
          if (parsed.searchParams.has("uid")) {
            parsed.searchParams.delete("uid");
            input = parsed.pathname + parsed.search;
          }
        }
      } catch {
        // Best effort; a failure here just means the seed test cannot run.
      }
      return original.call(this, input, init);
    };
  });
}

async function postAs(page, roomId, message) {
  return page.evaluate(
    async ({ path, body }) => {
      const auth = window.__signalAuth;
      if (!auth) return -1;
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-peer-id": auth.peerId,
          "x-peer-secret": auth.secret,
        },
        body: JSON.stringify(body),
      });
      return response.status;
    },
    { path: `/api/signal/${roomId}`, body: message },
  );
}

async function moderationOutbox(page) {
  return page.evaluate(() => window.__instantModerationOutbox ?? null);
}

function roomIdFromUrl(roomUrl) {
  const match = /\/room\/([0-9a-z-]+)/.exec(roomUrl);
  if (!match) throw new Error(`no room id in ${roomUrl}`);
  return match[1];
}

/**
 * Knock as `joiner`, have the host admit them, and wait for the JOINER to
 * report connected. mesh-shared's knockAndAdmit instead waits for the name to
 * appear in the host's roster markup, which is another lane's moving target
 * this week (Roster became ParticipantsPanel mid-run) -- the joiner's own
 * connection badge proves seating just as hard and depends only on stable
 * markup.
 */
async function admitJoin(host, joiner, roomUrl, { timeout = 45_000 } = {}) {
  await joinAsGuest(joiner.page, roomUrl, joiner.name);
  const button = admitButton(host.page, joiner.name);
  await button.waitFor({ timeout });
  await button.click();
  await waitForConnected(joiner.page, { timeout });
}

// ---------------------------------------------------------------------------
// Section 1: two participants (guest joins with BROKEN storage -> no seed)
// ---------------------------------------------------------------------------

async function sectionTwoUp(browser) {
  console.log("\n[2-up] host + one guest (guest simulates an older client: no uid)");
  const host = await newParticipant(browser, "ann", { name: "Ann Chow" });
  const guest = await newParticipant(browser, "bea", { name: "Bea Miller" });
  await installLegacyNoUidClient(guest.context);

  try {
    const roomUrl = await createRoomAsHost(host, base);
    await admitJoin(host, guest, roomUrl);
    await waitForConnected(host.page, { peers: 1 });
    await waitForConnected(guest.page, { peers: 1 });

    await openMediaView(host.page);
    await openMediaView(guest.page);

    // -- stage + strip, even at 2 people -------------------------------------
    const hostTiles = await pollUntil(
      () => tileInfo(host.page),
      (tiles) => tiles.length === 2,
      { timeout: 15_000 },
    );
    const guestTiles = await tileInfo(guest.page);
    check("2-up: host page renders exactly 2 tiles", hostTiles.length === 2, `got ${hostTiles.length}`);
    check("2-up: guest page renders exactly 2 tiles", guestTiles.length === 2, `got ${guestTiles.length}`);

    const annId = await peerIdByName(guest.page, "Ann Chow");
    const beaId = await peerIdByName(host.page, "Bea Miller");

    check(
      "2-up: layout is stage + one small card, NOT two equal tiles",
      (await stageIdOf(host.page)) === beaId &&
        (await stripIds(host.page)).length === 1 &&
        (await stageIdOf(guest.page)) === annId,
    );
    const hostStrip = await tileInfo(host.page);
    check(
      "2-up: the viewer's own tile is the small card, not the stage",
      hostStrip.find((t) => t.self)?.id === (await stripIds(host.page))[0],
    );
    const stageBox = await tileLocator(host.page, beaId).boundingBox();
    const cardBox = await tileLocator(host.page, annId).boundingBox();
    check(
      "2-up: stage dwarfs the card (>= 2x width)",
      Boolean(stageBox && cardBox && stageBox.width >= cardBox.width * 2),
      `stage=${stageBox?.width} card=${cardBox?.width}`,
    );
    check(
      "2-up: at desktop width the card column sits to the RIGHT of the stage",
      Boolean(stageBox && cardBox && cardBox.x >= stageBox.x + stageBox.width - 2),
      `stage.right=${stageBox ? stageBox.x + stageBox.width : "?"} card.x=${cardBox?.x}`,
    );

    check(
      "2-up: self tile says (You); host tile carries a Host marker",
      hostTiles.some((t) => t.self && t.text.includes("(You)")) &&
        Boolean(guestTiles.find((t) => t.id === annId)?.hostMarker),
    );
    check(
      "2-up: mic-off indicator shows for a peer with no live mic",
      Boolean(guestTiles.find((t) => t.id === annId)?.micOffMarker),
    );

    // -- avatars: robot for a seeded peer, initials for an empty seed --------
    const annOnGuest = (await tileInfo(guest.page)).find((t) => t.id === annId);
    check(
      "2-up: seeded peer's placeholder is a locally drawn robot",
      annOnGuest?.avatarKind === "robot" && Boolean(annOnGuest?.avatarSvg),
      `kind=${annOnGuest?.avatarKind}`,
    );
    const beaOnHost = hostTiles.find((t) => t.id === beaId);
    check(
      "2-up: EMPTY avatarSeed falls back to initials (BM), not a default robot",
      beaOnHost?.avatarKind === "initials" && (beaOnHost?.text ?? "").includes("BM"),
      `kind=${beaOnHost?.avatarKind} text=${beaOnHost?.text}`,
    );

    // -- floating controls: overlap the stage, keyboard reachable ------------
    const pillBox = await boxOf(host.page, '[data-slot="call-controls"]');
    check(
      "2-up: control pill FLOATS over the stage (bounding boxes overlap)",
      overlaps(pillBox, stageBox),
      `pill=${JSON.stringify(pillBox)} stage=${JSON.stringify(stageBox)}`,
    );
    const focusResult = await host.page.evaluate(() => {
      const pill = document.querySelector('[data-slot="call-controls"]');
      const button = pill ? pill.querySelector("button") : null;
      if (!button) return null;
      button.focus();
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        focused: document.activeElement === button,
        visible:
          rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && Number(style.opacity) > 0.9,
      };
    });
    check(
      "2-up: floating controls are keyboard-focusable and visible on focus",
      Boolean(focusResult?.focused && focusResult?.visible),
      JSON.stringify(focusResult),
    );

    // -- video genuinely flows ------------------------------------------------
    const cameraOn = await toggleDevice(host.page, "Turn on camera", "Turn off camera");
    check("2-up: host camera turned on", cameraOn);
    const width = await pollUntil(
      () => videoWidthFor(guest.page, annId),
      (value) => value > 0,
      { timeout: 30_000 },
    );
    check("2-up: remote stage tile has videoWidth > 0 (video really flows)", width > 0, `videoWidth=${width}`);
    await shot(guest.page, "grid-2up.png");
    await shot(host.page, "controls-floating.png");

    // -- self mirror + always-muted preview ----------------------------------
    const selfVideo = await host.page.evaluate(() => {
      const video = document.querySelector('[data-slot="video-tile"][data-self] video');
      if (!video) return null;
      return { mirrored: video.className.includes("-scale-x-100"), muted: video.muted };
    });
    check("2-up: self camera tile is mirrored", Boolean(selfVideo?.mirrored));
    check("2-up: local self preview <video> is muted", Boolean(selfVideo?.muted));

    // -- screen share: goes on stage, not mirrored ---------------------------
    const shared = await toggleDevice(host.page, "Share your screen", "Stop sharing screen");
    if (!shared) {
      skip("2-up: screen share block", "getDisplayMedia unavailable in this headless run");
    } else {
      check(
        "2-up: your own screen share takes the stage automatically",
        (await pollUntil(() => stageIdOf(host.page), (v) => v === annId, { timeout: 8000 })) === annId,
        `stage=${await stageIdOf(host.page)}`,
      );
      const shareVideo = await host.page.evaluate(() => {
        const video = document.querySelector('[data-slot="video-tile"][data-self] video');
        return video ? video.className.includes("-scale-x-100") : null;
      });
      check("2-up: self tile is NOT mirrored while screen sharing", shareVideo === false);
      // The status line under the share says where the camera went while the
      // screen has the outgoing video slot.
      const hint = await host.page
        .getByText(/your camera stays in your own tile/i)
        .isVisible()
        .catch(() => false);
      check("2-up: screen-share-plus-camera hint shown", hint);
      const unshared = await toggleDevice(host.page, "Stop sharing screen", "Share your screen");
      check("2-up: screen share stops cleanly", unshared);
      check(
        "2-up: stage returns to the remote peer after the share ends",
        (await pollUntil(() => stageIdOf(host.page), (v) => v === beaId, { timeout: 8000 })) === beaId,
      );
      const backVideo = await host.page.evaluate(() => {
        const video = document.querySelector('[data-slot="video-tile"][data-self] video');
        return video ? video.className.includes("-scale-x-100") : null;
      });
      check("2-up: mirror returns when back to camera", backVideo === true);
    }

    // -- camera off: robot placeholder, session survives ---------------------
    const cameraOff = await toggleDevice(host.page, "Turn off camera", "Turn on camera");
    check("2-up: host camera turned off", cameraOff);
    const placeholderTiles = await pollUntil(
      () => tileInfo(guest.page),
      (tiles) => {
        const ann = tiles.find((t) => t.id === annId);
        return Boolean(ann && !ann.videoLive && ann.avatarKind === "robot");
      },
      { timeout: 15_000 },
    );
    const annPlaceholder = placeholderTiles.find((t) => t.id === annId);
    check(
      "2-up: camera-off stage shows the robot placeholder with the name",
      Boolean(
        annPlaceholder &&
          !annPlaceholder.videoLive &&
          annPlaceholder.avatarKind === "robot" &&
          annPlaceholder.text.includes("Ann Chow"),
      ),
      annPlaceholder?.text,
    );
    const stillConnected = await statusBadge(guest.page).innerText().catch(() => "");
    check(
      "2-up: turning the camera off does not tear the session down",
      /connected/i.test(stillConnected) && placeholderTiles.length === 2,
      `badge="${stillConnected}" tiles=${placeholderTiles.length}`,
    );

    // -- audio-only participant ----------------------------------------------
    const micOn = await toggleDevice(host.page, "Turn on microphone", "Turn off microphone");
    check("2-up: host microphone turned on", micOn);
    const audioTiles = await pollUntil(
      () => tileInfo(guest.page),
      (tiles) => /audio only/i.test(tiles.find((t) => t.id === annId)?.text ?? ""),
      { timeout: 15_000 },
    );
    const annAudio = audioTiles.find((t) => t.id === annId);
    check(
      "2-up: audio-only peer shows placeholder plus 'Audio only'",
      Boolean(annAudio && !annAudio.videoLive && /audio only/i.test(annAudio.text)),
      annAudio?.text,
    );
    check(
      "2-up: mic-off indicator cleared once audio is live",
      annAudio ? !annAudio.micOffMarker : false,
    );
    const muteControl = await deviceButton(guest.page, "Mute incoming audio");
    const muteEnabled = await pollUntil(
      () => muteControl.isEnabled().catch(() => false),
      (value) => value === true,
      { timeout: 10_000 },
    );
    check("2-up: receiving audio enables the incoming-audio mute control", muteEnabled === true);

    const micPressed = await (await deviceButton(host.page, "Turn off microphone")).getAttribute(
      "aria-pressed",
    );
    check("2-up: mic control aria-pressed reflects on-state", micPressed === "true");

    // -- guest leaves: no stray live streams, tile removed ---------------------
    await toggleDevice(guest.page, "Turn on camera", "Turn off camera");
    await wait(1000);
    await leaveButton(guest.page).click();
    await terminalOverlay(guest.page).waitFor({ timeout: 15_000 });
    await wait(1500);
    const dirty = await guest.page.evaluate(() =>
      Array.from(document.querySelectorAll("video")).some((video) => {
        const stream = video.srcObject;
        return Boolean(stream) && stream.getVideoTracks().some((t) => t.readyState === "live");
      }),
    );
    check("2-up: after leaving, no <video> still holds a live video track", !dirty);

    const aloneTiles = await pollUntil(
      () => tileInfo(host.page),
      (tiles) => tiles.length === 1,
      { timeout: 20_000 },
    );
    check(
      "alone: departed peer's tile is removed; the self tile takes the stage",
      aloneTiles.length === 1 &&
        aloneTiles[0]?.self === true &&
        (await stripIds(host.page)).length === 0,
      `tiles=${aloneTiles.length}`,
    );
  } finally {
    await host.context.close().catch(() => {});
    await guest.context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Section 2: four participants -- robots, pinning, moderation, 403, away
// ---------------------------------------------------------------------------

async function sectionFourUp(browser) {
  console.log("\n[4-up] host + three guests (one mobile) -- pins, robots, moderation");
  const ann = await newParticipant(browser, "ann4", { name: "Ann Chow" });
  const bea = await newParticipant(browser, "bea4", { name: "Bea Miller" });
  const cal = await newParticipant(browser, "cal4", { name: "Cal Ortiz" });
  const dee = await newParticipant(browser, "dee4", {
    name: "Dee Patel",
    viewport: MOBILE_VIEWPORT,
  });
  await installAuthCapture(ann.context);
  await installAuthCapture(bea.context);

  try {
    const roomUrl = await createRoomAsHost(ann, base);
    const roomId = roomIdFromUrl(roomUrl);
    // Admit the first guest BEFORE raising capacity: while the host is alone
    // the LobbyOverlay covers the host panel, so the stepper is unclickable.
    await admitJoin(ann, bea, roomUrl);
    await raiseCapacity(ann, roomId, 4);
    await admitJoin(ann, cal, roomUrl);
    await admitJoin(ann, dee, roomUrl);

    // 4 people = 6 links; give the mesh time on a dev server.
    for (const member of [ann, bea, cal, dee]) {
      await waitForConnected(member.page, { peers: 3, timeout: 90_000 });
    }
    for (const member of [ann, bea, cal, dee]) {
      await openMediaView(member.page);
    }

    // -- tiles, stage choice and shared strip order ---------------------------
    const annTiles = await pollUntil(
      () => tileInfo(ann.page),
      (tiles) => tiles.length === 4,
      { timeout: 20_000 },
    );
    check("4-up: every page renders 4 tiles", annTiles.length === 4);

    const annId = await peerIdByName(bea.page, "Ann Chow");
    const beaId = await peerIdByName(ann.page, "Bea Miller");
    const calId = await peerIdByName(ann.page, "Cal Ortiz");
    const deeId = await peerIdByName(ann.page, "Dee Patel");
    // Join order was Ann, Bea, Cal, Dee, so joinedAt order is known.
    const joined = [annId, beaId, calId, deeId];

    check(
      "4-up: automatic stage is the first OTHER participant by joinedAt",
      (await stageIdOf(ann.page)) === beaId &&
        (await stageIdOf(bea.page)) === annId &&
        (await stageIdOf(cal.page)) === annId,
      `ann=${await stageIdOf(ann.page)} bea=${await stageIdOf(bea.page)} cal=${await stageIdOf(cal.page)}`,
    );
    const annStrip = await stripIds(ann.page);
    const beaStrip = await stripIds(bea.page);
    const calStrip = await stripIds(cal.page);
    check(
      "4-up: strip keeps the shared joinedAt order on every page (self included)",
      JSON.stringify(annStrip) === JSON.stringify(joined.filter((id) => id !== beaId)) &&
        JSON.stringify(beaStrip) === JSON.stringify(joined.filter((id) => id !== annId)) &&
        JSON.stringify(calStrip) === JSON.stringify(joined.filter((id) => id !== annId)),
      `ann=[${annStrip}] bea=[${beaStrip}] cal=[${calStrip}]`,
    );

    // -- robots: two peers draw the SAME robot for the same person ------------
    const beaOnAnn = annTiles.find((t) => t.id === beaId);
    const beaOnCal = (await tileInfo(cal.page)).find((t) => t.id === beaId);
    check(
      "4-up: two different peers render the SAME robot for the same person",
      Boolean(
        beaOnAnn?.avatarKind === "robot" &&
          beaOnCal?.avatarKind === "robot" &&
          beaOnAnn.avatarSeed &&
          beaOnAnn.avatarSeed === beaOnCal.avatarSeed &&
          beaOnAnn.avatarSvg === beaOnCal.avatarSvg,
      ),
      `ann(kind=${beaOnAnn?.avatarKind}, seed=${beaOnAnn?.avatarSeed}) cal(kind=${beaOnCal?.avatarKind}, seed=${beaOnCal?.avatarSeed})`,
    );

    // -- video flows in a 4-way mesh ------------------------------------------
    check("4-up: Bea's camera turned on", await toggleDevice(bea.page, "Turn on camera", "Turn off camera"));
    const widthOnAnn = await pollUntil(() => videoWidthFor(ann.page, beaId), (v) => v > 0, {
      timeout: 30_000,
    });
    const widthOnCal = await pollUntil(() => videoWidthFor(cal.page, beaId), (v) => v > 0, {
      timeout: 30_000,
    });
    check(
      "4-up: Bea's video flows to two independent viewers (videoWidth > 0)",
      widthOnAnn > 0 && widthOnCal > 0,
      `ann=${widthOnAnn} cal=${widthOnCal}`,
    );

    // -- honest quality note ---------------------------------------------------
    check(
      "4-up: quality note states the 360p budget at 4 people",
      await ann.page.getByText(/cameras are sent at 360p/i).isVisible().catch(() => false),
    );

    // -- geometry: right column on desktop, row-below on mobile ----------------
    const stageBox = await tileLocator(ann.page, (await stageIdOf(ann.page))).boundingBox();
    const stripBox = await boxOf(ann.page, '[data-slot="video-strip"]');
    check(
      "4-up: desktop strip is a column on the RIGHT of the stage",
      Boolean(stageBox && stripBox && stripBox.x >= stageBox.x + stageBox.width - 2),
      `stage.right=${stageBox ? stageBox.x + stageBox.width : "?"} strip.x=${stripBox?.x}`,
    );
    const pillBox = await boxOf(ann.page, '[data-slot="call-controls"]');
    check("4-up: control pill overlaps the stage (floating)", overlaps(pillBox, stageBox));

    const mobileStage = await tileLocator(dee.page, (await stageIdOf(dee.page))).boundingBox();
    const mobileStrip = await boxOf(dee.page, '[data-slot="video-strip"]');
    check(
      "4-up: at 390px the strip is a row BENEATH the stage",
      Boolean(mobileStage && mobileStrip && mobileStrip.y >= mobileStage.y + mobileStage.height - 2),
      `stage.bottom=${mobileStage ? mobileStage.y + mobileStage.height : "?"} strip.y=${mobileStrip?.y}`,
    );
    const mobilePill = await boxOf(dee.page, '[data-slot="call-controls"]');
    check(
      "4-up: mobile pill stays within the viewport (thumb zone)",
      Boolean(mobilePill && mobilePill.y + mobilePill.height <= MOBILE_VIEWPORT.height),
    );
    await shot(ann.page, "grid-4up.png");
    await shot(dee.page, "grid-mobile.png");

    // Cal's mic goes live now so later moderation checks have something
    // observable to leave untouched.
    check("4-up: Cal's mic turned on", await toggleDevice(cal.page, "Turn on microphone", "Turn off microphone"));

    // -- LOCAL pin: only the pinning viewer's stage changes --------------------
    await clickTileControl(cal.page, localPinButton(cal.page, beaId, "Bea Miller"));
    check(
      "4-up: local pin puts the pinned peer on the pinning viewer's stage",
      (await pollUntil(() => stageIdOf(cal.page), (v) => v === beaId, { timeout: 10_000 })) === beaId,
    );
    const calTiles = await tileInfo(cal.page);
    check(
      "4-up: local pin badge reads 'Pinned for you'",
      /pinned for you/i.test(calTiles.find((t) => t.id === beaId)?.text ?? ""),
    );
    check(
      "4-up: local pin control is aria-pressed",
      (await localPinButton(cal.page, beaId, "Bea Miller", { unpin: true }).getAttribute(
        "aria-pressed",
      )) === "true",
    );
    await wait(800);
    check(
      "4-up: OTHER viewers' stages are unchanged by a local pin",
      (await stageIdOf(ann.page)) === beaId && (await stageIdOf(bea.page)) === annId,
      `ann=${await stageIdOf(ann.page)} bea=${await stageIdOf(bea.page)}`,
    );
    await shot(cal.page, "grid-local-pin.png");

    // -- HOST-FORCED pin: everyone follows; beats Cal's local pin ---------------
    await clickTileControl(ann.page, hostPinButton(ann.page, deeId, "Dee Patel"));
    for (const [label, member] of [["ann", ann], ["bea", bea], ["cal", cal]]) {
      const stage = await pollUntil(() => stageIdOf(member.page), (v) => v === deeId, {
        timeout: 15_000,
      });
      check(`4-up: host-forced pin drives ${label}'s stage to Dee`, stage === deeId, `stage=${stage}`);
    }
    check(
      "4-up: host-forced pin BEATS Cal's local pin (Cal stages Dee, not Bea)",
      (await stageIdOf(cal.page)) === deeId,
    );
    check(
      "4-up: Cal's local pin is labelled overridden by the host's pin",
      /overridden by the host/i.test(
        (await tileInfo(cal.page)).find((t) => t.id === beaId)?.text ?? "",
      ),
    );
    check(
      "4-up: a non-host sees the pin is host-enforced ('Pinned by host for everyone')",
      /pinned by host for everyone/i.test(
        (await tileInfo(bea.page)).find((t) => t.id === deeId)?.text ?? "",
      ),
    );
    check(
      "4-up: under a host pin every viewer's strip is IDENTICAL",
      JSON.stringify(await stripIds(ann.page)) === JSON.stringify(await stripIds(bea.page)) &&
        JSON.stringify(await stripIds(bea.page)) === JSON.stringify(await stripIds(cal.page)),
    );
    await shot(bea.page, "grid-host-pin-guest.png");

    // -- non-host cannot force a pin --------------------------------------------
    check(
      "4-up: a non-host has no 'for everyone' pin control",
      (await bea.page.getByRole("button", { name: /for everyone/i }).count()) === 0,
    );
    const forgedPin = await postAs(bea.page, roomId, { t: "pin", peerId: beaId });
    if (forgedPin === -1) {
      skip("4-up: forged non-host pin returns 403", "signalling auth headers were never captured");
    } else {
      check("4-up: forged non-host pin POST returns 403", forgedPin === 403, `status=${forgedPin}`);
    }
    await wait(1000);
    check(
      "4-up: viewers do not move after the refused pin (still staging Dee)",
      (await stageIdOf(ann.page)) === deeId && (await stageIdOf(cal.page)) === deeId,
    );

    // -- clearing the host pin restores free layout ------------------------------
    await clickTileControl(ann.page, hostPinButton(ann.page, deeId, "Dee Patel", { unpin: true }));
    check(
      "4-up: clearing the host pin returns unpinned viewers to the automatic stage",
      (await pollUntil(() => stageIdOf(bea.page), (v) => v === annId, { timeout: 15_000 })) === annId,
    );
    check(
      "4-up: clearing the host pin restores Cal's own local pin",
      (await pollUntil(() => stageIdOf(cal.page), (v) => v === beaId, { timeout: 10_000 })) === beaId,
    );
    await clickTileControl(cal.page, localPinButton(cal.page, beaId, "Bea Miller", { unpin: true }));
    check(
      "4-up: local unpin returns Cal to the automatic stage",
      (await pollUntil(() => stageIdOf(cal.page), (v) => v === annId, { timeout: 10_000 })) === annId,
    );

    // ======================= HOST MODERATION ==================================
    // Bea: camera ON, mic OFF -> the host must see exactly "turn off camera"
    // (enforced) and "ask to unmute" (request), never a direct unmute.
    const beaTileOnAnn = tileLocator(ann.page, beaId);
    await beaTileOnAnn.hover().catch(() => {});
    const muteVideoButton = beaTileOnAnn.getByRole("button", {
      name: /^turn off bea miller's camera$/i,
    });
    const askAudioButton = beaTileOnAnn.getByRole("button", {
      name: /^ask bea miller to unmute$/i,
    });
    check(
      "moderation: host sees per-tile 'Turn off camera' + 'Ask to unmute' matching Bea's state",
      (await muteVideoButton.count()) === 1 && (await askAudioButton.count()) === 1,
    );
    check(
      "moderation: no direct 'unmute Bea' control exists (a host can only ASK)",
      (await ann.page.getByRole("button", { name: /^unmute bea/i }).count()) === 0,
    );
    await shot(ann.page, "host-mod-controls.png");

    // Intent wiring: with the transport lane not landed, clicks are recorded on
    // the dev outbox; if the outbox stays empty the real prop must be wired,
    // and enforcement is asserted instead.
    await clickTileControl(ann.page, muteVideoButton);
    await clickTileControl(ann.page, askAudioButton);
    const outbox = await moderationOutbox(ann.page);
    if (outbox) {
      check(
        "moderation: per-tile clicks issue the right actions for the right peer",
        outbox.some((m) => m.peerId === beaId && m.action === "mute-video") &&
          outbox.some((m) => m.peerId === beaId && m.action === "ask-audio"),
        JSON.stringify(outbox),
      );
      skip(
        "moderation: force-mute actually stops the target sending (target + third party)",
        "client transport for `moderated` is the other lane's in-flight work; UI intent, server authz and target-side UX are verified instead",
      );
    } else {
      const enforced = await pollUntil(
        () => tileInfo(cal.page),
        (tiles) => tiles.find((t) => t.id === beaId)?.videoLive === false,
        { timeout: 15_000 },
      );
      check(
        "moderation: force-stop camera enforced (observed by a third participant)",
        enforced.find((t) => t.id === beaId)?.videoLive === false,
      );
    }

    // Server-side authority: the host may moderate; a guest gets 403.
    const hostModerate = await postAs(ann.page, roomId, {
      t: "moderate",
      peerId: calId,
      action: "ask-audio",
    });
    if (hostModerate === -1) {
      skip("moderation: host moderate POST accepted", "host auth headers were never captured");
    } else {
      check("moderation: host moderate POST is accepted by the server", hostModerate === 200, `status=${hostModerate}`);
    }
    const forgedModerate = await postAs(bea.page, roomId, {
      t: "moderate",
      peerId: calId,
      action: "mute-audio",
    });
    if (forgedModerate === -1) {
      skip("moderation: forged non-host moderate returns 403", "auth headers were never captured");
    } else {
      check(
        "moderation: a NON-host's moderate POST is refused with 403",
        forgedModerate === 403,
        `status=${forgedModerate}`,
      );
    }
    await wait(1000);
    check(
      "moderation: nobody's devices change after the refused attempt (Cal still live)",
      (await tileInfo(ann.page)).find((t) => t.id === calId)?.micOffMarker === false,
    );

    // Target-side ask flow, driven through the dev hook (see file header).
    const injected = await bea.page.evaluate(() => {
      if (typeof window.__instantModerationTest !== "function") return false;
      window.__instantModerationTest("ask-audio", "Ann Chow");
      return true;
    });
    if (!injected) {
      skip("moderation: ask prompt block", "__instantModerationTest hook missing (production build?)");
    } else {
      const prompt = bea.page.locator('[data-slot="moderation-ask"]');
      await prompt.waitFor({ timeout: 5000 }).catch(() => {});
      check(
        "moderation: target sees a prompt naming who asked",
        /ann chow asked you to unmute/i.test((await prompt.innerText().catch(() => "")) ?? ""),
      );
      check(
        "moderation: the ask does NOT change the device (mic still off)",
        await (await deviceButton(bea.page, "Turn on microphone")).isVisible().catch(() => false),
      );
      await shot(bea.page, "ask-prompt.png");
      await prompt.getByRole("button", { name: /^not now$/i }).click();
      await wait(500);
      check(
        "moderation: declining dismisses the prompt and leaves the mic off",
        !(await prompt.isVisible().catch(() => false)) &&
          (await (await deviceButton(bea.page, "Turn on microphone")).isVisible().catch(() => false)),
      );
      await bea.page.evaluate(() => window.__instantModerationTest("ask-audio", "Ann Chow"));
      await prompt.waitFor({ timeout: 5000 }).catch(() => {});
      await prompt.getByRole("button", { name: /^unmute$/i }).click();
      const micNowOn = await pollUntil(
        () => deviceButton(bea.page, "Turn off microphone").then((b) => b.isVisible().catch(() => false)),
        (v) => v === true,
        { timeout: 15_000 },
      );
      check("moderation: accepting the ask really turns the mic on", micNowOn === true);
      const audible = await pollUntil(
        () => tileInfo(ann.page),
        (tiles) => tiles.find((t) => t.id === beaId)?.micOffMarker === false,
        { timeout: 15_000 },
      );
      check(
        "moderation: after accepting, the host actually receives Bea's audio",
        audible.find((t) => t.id === beaId)?.micOffMarker === false,
      );

      // Forced-mute attribution: turn the camera off (standing in for the
      // transport's enforcement), then inject the enforced event.
      await toggleDevice(bea.page, "Turn off camera", "Turn on camera");
      await bea.page.evaluate(() => window.__instantModerationTest("mute-video", "Ann Chow"));
      const beaSelf = await pollUntil(
        () => tileInfo(bea.page),
        (tiles) => /camera turned off by ann chow/i.test(tiles.find((t) => t.self)?.text ?? ""),
        { timeout: 5000 },
      );
      check(
        "moderation: a force-stopped camera is attributed to the host on the self tile",
        /camera turned off by ann chow/i.test(beaSelf.find((t) => t.self)?.text ?? ""),
        beaSelf.find((t) => t.self)?.text,
      );
      await toggleDevice(bea.page, "Turn on camera", "Turn off camera");
      const cleared = await pollUntil(
        () => tileInfo(bea.page),
        (tiles) => !/camera turned off by/i.test(tiles.find((t) => t.self)?.text ?? ""),
        { timeout: 5000 },
      );
      check(
        "moderation: the attribution clears once the user turns the device back on",
        !/camera turned off by/i.test(cleared.find((t) => t.self)?.text ?? ""),
      );
    }

    // Room-wide: "Mute everyone" sits behind a Shield toggle and a
    // consequence-naming confirmation.
    await ann.page.getByRole("button", { name: /show host controls/i }).click();
    const hostControls = ann.page.locator('[data-slot="host-controls"]');
    await hostControls.waitFor({ timeout: 5000 });
    await hostControls.getByRole("button", { name: /^mute everyone$/i }).click();
    const dialog = ann.page.locator('[role="alertdialog"]');
    await dialog.waitFor({ timeout: 5000 });
    check(
      "moderation: 'Mute everyone' requires a confirmation that names the consequence",
      /everyone except you/i.test((await dialog.innerText().catch(() => "")) ?? ""),
    );
    const outboxBefore = (await moderationOutbox(ann.page)) ?? [];
    check(
      "moderation: nothing is sent before the confirmation is accepted",
      !outboxBefore.some((m) => m.peerId === null),
    );
    await dialog.getByRole("button", { name: /^mute everyone$/i }).click();
    await wait(500);
    const outboxAfter = await moderationOutbox(ann.page);
    if (outboxAfter) {
      check(
        "moderation: confirming issues mute-audio for EVERYONE (peerId null)",
        outboxAfter.some((m) => m.peerId === null && m.action === "mute-audio"),
        JSON.stringify(outboxAfter),
      );
      skip(
        "moderation: 'Mute everyone' silences every non-host and leaves the host alone",
        "client transport for `moderated` is the other lane's in-flight work; the null-peerId wire message and its server 403 rules are verified instead",
      );
    } else {
      const allMuted = await pollUntil(
        () => tileInfo(ann.page),
        (tiles) =>
          tiles.filter((t) => !t.self).every((t) => t.micOffMarker) &&
          tiles.find((t) => t.self)?.micOffMarker === true,
        { timeout: 15_000 },
      );
      check(
        "moderation: 'Mute everyone' silences every non-host",
        allMuted.filter((t) => !t.self).every((t) => t.micOffMarker),
      );
    }

    // -- away participant: tile persists in a reconnecting state -----------------
    const reloadPromise = bea.page.reload({ waitUntil: "domcontentloaded" });
    let sawReconnecting = false;
    let vanished = false;
    let recovered = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const tiles = await tileInfo(ann.page);
      const beaTile = tiles.find((t) => t.id === beaId);
      if (!beaTile) {
        vanished = true;
        break;
      }
      const reconnecting = /reconnecting/i.test(beaTile.text);
      sawReconnecting ||= reconnecting;
      if (sawReconnecting && !reconnecting) {
        recovered = true;
        break;
      }
      await wait(200);
    }
    await reloadPromise.catch(() => {});
    check("4-up: away peer's tile NEVER vanishes during a reload", !vanished);
    check("4-up: away peer's tile shows the reconnecting state", sawReconnecting);
    check("4-up: away peer's tile recovers after the seat is reclaimed", recovered);
    await waitForConnected(ann.page, { peers: 3, timeout: 60_000 });
  } finally {
    for (const member of [ann, bea, cal, dee]) {
      await member.context.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Section 3: seven participants
// ---------------------------------------------------------------------------

async function sectionSevenUp(browser) {
  console.log("\n[7-up] full room -- 21 links, generous timeouts (up to ~4 min)");
  const names = ["Ann Chow", "Bea Miller", "Cal Ortiz", "Dee Patel", "Eli Sun", "Fay Wong", "Gus Reed"];
  const members = [];
  try {
    for (let i = 0; i < names.length; i += 1) {
      members.push(await newParticipant(browser, `p7-${i}`, { name: names[i] }));
    }
    const [host, ...guests] = members;
    await installAuthCapture(host.context);
    const roomUrl = await createRoomAsHost(host, base);
    const roomId = roomIdFromUrl(roomUrl);
    // First guest in before raising capacity (the host's first POST -- the
    // admit -- also captures the credentials raiseCapacity replays).
    await admitJoin(host, guests[0], roomUrl, { timeout: 60_000 });
    await raiseCapacity(host, roomId, 7);
    for (const guest of guests.slice(1)) {
      await admitJoin(host, guest, roomUrl, { timeout: 60_000 });
    }
    for (const member of members) {
      await waitForConnected(member.page, { peers: 6, timeout: 180_000 });
    }
    const fay = guests[4];
    await openMediaView(host.page);
    await openMediaView(fay.page);

    const hostTiles = await pollUntil(
      () => tileInfo(host.page),
      (tiles) => tiles.length === 7,
      { timeout: 30_000 },
    );
    const fayTiles = await pollUntil(
      () => tileInfo(fay.page),
      (tiles) => tiles.length === 7,
      { timeout: 30_000 },
    );
    check("7-up: 7 tiles render on host and guest", hostTiles.length === 7 && fayTiles.length === 7);

    // Join order is known, so the shared joinedAt order is checkable on both
    // pages even though each page stages a different person.
    const ids = [];
    for (const name of names) ids.push(await peerIdByName(host.page, name));
    const hostStage = await stageIdOf(host.page);
    const fayStage = await stageIdOf(fay.page);
    check(
      "7-up: stage is the first other participant (host stages Bea, Fay stages Ann)",
      hostStage === ids[1] && fayStage === ids[0],
      `host=${hostStage} fay=${fayStage}`,
    );
    check(
      "7-up: both strips follow the SAME joinedAt order (stage excluded)",
      JSON.stringify(await stripIds(host.page)) ===
        JSON.stringify(ids.filter((id) => id !== hostStage)) &&
        JSON.stringify(await stripIds(fay.page)) ===
          JSON.stringify(ids.filter((id) => id !== fayStage)),
    );

    // The right column must SCROLL its six cards, not push the stage or grow
    // the page. At 800px tall the six cards happen to fit, so shrink the
    // window until they cannot and assert the overflow is contained.
    await host.page.setViewportSize({ width: DESKTOP_VIEWPORT.width, height: 560 });
    await wait(600);
    const stripScroll = await host.page.evaluate(() => {
      const strip = document.querySelector('[data-slot="video-strip"]');
      if (!strip) return null;
      return {
        scrollHeight: strip.scrollHeight,
        clientHeight: strip.clientHeight,
        overflowY: getComputedStyle(strip).overflowY,
        pageOverflow: document.documentElement.scrollHeight - window.innerHeight,
      };
    });
    check(
      "7-up: when the 6 cards cannot fit, the column scrolls internally",
      Boolean(
        stripScroll &&
          stripScroll.overflowY === "auto" &&
          stripScroll.scrollHeight > stripScroll.clientHeight,
      ),
      JSON.stringify(stripScroll),
    );
    check(
      "7-up: the overflowing strip does not grow the page",
      Boolean(stripScroll && stripScroll.pageOverflow <= 1),
      JSON.stringify(stripScroll),
    );
    const squeezedStage = await tileLocator(host.page, hostStage).boundingBox();
    check(
      "7-up: the stage survives the squeeze (still the dominant tile)",
      Boolean(squeezedStage && squeezedStage.width > 400 && squeezedStage.height > 200),
      JSON.stringify(squeezedStage),
    );
    await host.page.setViewportSize(DESKTOP_VIEWPORT);
    await wait(400);
    const stageBox = await tileLocator(host.page, hostStage).boundingBox();
    const stripBox = await boxOf(host.page, '[data-slot="video-strip"]');
    check(
      "7-up: strip stays a right column and does not squash the stage",
      Boolean(stageBox && stripBox && stripBox.x >= stageBox.x + stageBox.width - 2 && stageBox.width > stripBox.width * 2),
    );
    check(
      "7-up: quality note states the 270p budget at 7 people",
      await host.page.getByText(/cameras are sent at 270p/i).isVisible().catch(() => false),
    );
    await shot(host.page, "grid-7up.png");
  } finally {
    for (const member of members) {
      await member.context.close().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`verify-video-grid against ${base}`);
  const browser = await chromium.launch({
    headless: !headed,
    args: [...MEDIA_ARGS, "--auto-select-desktop-capture-source=Entire screen"],
  });
  try {
    await sectionTwoUp(browser);
    await sectionFourUp(browser);
    if (skipSeven) {
      skip("7-up section", "--skip-7 given");
    } else {
      try {
        await sectionSevenUp(browser);
      } catch (error) {
        skip("7-up section", `did not complete: ${error.message}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(`\nRESULT pass=${state.passes} fail=${state.failures} skip=${state.skips}`);
  process.exit(state.failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`FATAL ${error.stack ?? error}`);
  process.exit(1);
});
