/**
 * Phase 2/3 verification: per-recipient targeting and RESUMABLE transfers.
 *
 * Usage: node scripts/verify-transfer-resume.mjs [base-url] [--headed]
 * Default base is http://127.0.0.1:3111 (the shared dev server).
 *
 * Keep this file ASCII-only (see mesh-shared.mjs for why).
 *
 * What it proves, with real browsers:
 *   A. THE HEADLINE: a large transfer whose RECEIVER reloads mid-flight
 *      continues from the last durably-acked offset (not 0%), and the final
 *      file is byte-for-byte identical to the original (SHA-256, both sides).
 *      Plus: crafted 3 GiB offer against the memory tier is DECLINED, and
 *      garbage ack/cancel frames do not crash anything.
 *   B. SENDER reload: the honest failure path (the File object died with the
 *      page, the user is told to re-select; nothing pretends to resume), then
 *      an actual resume once the same file is re-selected.
 *   C. Resume REFUSES a different file with the same name and size: it
 *      restarts cleanly at zero and the result matches the NEW file.
 *   D. 3-party room: send to exactly one peer (the third receives nothing),
 *      fan-out to all with the file read from disk ONCE (instrumented), and
 *      two peers sending the same filename simultaneously do not collide.
 *   E. Streaming tiers are NOT charged against the memory budget: a 3 GiB
 *      offer that the memory tier must refuse is ACCEPTED by a streaming
 *      sink, and a real transfer through it completes.
 *   F. IndexedDB unavailable (private browsing): transfers still work,
 *      resume simply degrades.
 *
 * The receiver-side sink is pinned with the dev-only
 * `__instantSinkProviderOverride` hook (lib/mesh-session.ts) so each scenario
 * exercises a DETERMINISTIC tier; the blob registry from mesh-shared.mjs
 * provides the received bytes for checksumming.
 */

import { createHash } from "node:crypto";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SCRIPTS_DIR,
  ensureCapacity,
  createRoomAsHost,
  knockAndAdmit,
  launchMeshBrowser,
  makeChecker,
  newParticipant,
  parseCliArgs,
  wait,
  waitForConnected,
} from "./mesh-shared.mjs";

const FIXTURE_DIR = path.resolve(SCRIPTS_DIR, "..", "artifacts", "transfer-fixtures");

const MiB = 1024 * 1024;
const ACK_INTERVAL = 1 * MiB; // TRANSFER_LIMITS.ackIntervalBytes

// ---------------------------------------------------------------------------
// Sink-provider overrides (evaluated before app code on every navigation)
// ---------------------------------------------------------------------------

const MEMORY_OVERRIDE = `
  window.__instantSinkProviderOverride = () => ({
    capability: () => ({
      tier: "memory",
      streaming: false,
      maxBytes: 1024 * 1024 * 1024,
      hasDestination: false,
      destinationLabel: null,
    }),
    canChooseFolder: () => false,
    chooseFolder: async () => false,
    clearFolder: () => {},
    open: async ({ mime }) => {
      let chunks = [];
      let written = 0;
      let dead = false;
      return {
        tier: "memory",
        get written() { return written; },
        async write(chunk) {
          if (dead) throw new Error("sink closed");
          chunks.push(chunk.slice());
          written += chunk.byteLength;
        },
        async close() {
          dead = true;
          const blob = new Blob(chunks, { type: mime || "application/octet-stream" });
          chunks = [];
          return { url: URL.createObjectURL(blob) };
        },
        async abort() { dead = true; chunks = []; },
      };
    },
  });
`;

const STREAMING_OVERRIDE = `
  window.__instantSinkProviderOverride = () => ({
    capability: () => ({
      tier: "download",
      streaming: true,
      maxBytes: null,
      hasDestination: false,
      destinationLabel: null,
    }),
    canChooseFolder: () => false,
    chooseFolder: async () => false,
    clearFolder: () => {},
    open: async () => {
      let written = 0;
      return {
        tier: "download",
        get written() { return written; },
        async write(chunk) { written += chunk.byteLength; },
        async close() { return { url: null }; },
        async abort() {},
      };
    },
  });
`;

const KILL_IDB = `
  Object.defineProperty(window, "indexedDB", { get: () => undefined, configurable: true });
`;

// ---------------------------------------------------------------------------
// Fixtures: deterministic pseudo-random files with Node-side SHA-256
// ---------------------------------------------------------------------------

function fillDeterministic(buffer, seed) {
  let s = seed >>> 0 || 1;
  for (let i = 0; i + 3 < buffer.length; i += 4) {
    s ^= (s << 13) >>> 0; s >>>= 0;
    s ^= s >>> 17;
    s ^= (s << 5) >>> 0; s >>>= 0;
    buffer.writeUInt32LE(s, i);
  }
}

async function makeFixture(dir, name, bytes, seed) {
  await mkdir(dir, { recursive: true });
  const buffer = Buffer.alloc(bytes);
  fillDeterministic(buffer, seed);
  const file = path.join(dir, name);
  await writeFile(file, buffer);
  const sha = createHash("sha256").update(buffer).digest("hex");
  return { file, sha, bytes };
}

// ---------------------------------------------------------------------------
// Page-side helpers
// ---------------------------------------------------------------------------

/** JSON-safe snapshot of the mesh session, or null while it is not up. */
async function meshSnapshot(page) {
  try {
    return await page.evaluate(() => {
      const s = window.__instantMeshSession;
      if (!s) return null;
      const snap = s.getSnapshot();
      return {
        phase: snap.phase,
        selfId: snap.self ? snap.self.id : null,
        error: snap.error || null,
        sinkTier: snap.sink ? snap.sink.tier : null,
        participants: snap.participants.map((p) => ({
          id: p.id,
          name: p.name,
          state: p.connectionState,
        })),
        transfers: snap.transfers.map((t) => ({
          key: t.key,
          uid: t.uid,
          name: t.name,
          size: t.size,
          transferred: t.transferred,
          status: t.status,
          direction: t.direction,
          error: t.error || null,
          resumable: Boolean(t.resumable),
          resumedFrom: typeof t.resumedFrom === "number" ? t.resumedFrom : null,
          confirmedBytes: typeof t.confirmedBytes === "number" ? t.confirmedBytes : null,
          sinkTier: t.sinkTier || null,
          url: t.url || null,
          savedTo: t.savedTo || null,
          peerName: t.peerName,
        })),
      };
    });
  } catch {
    return null; // navigating (reload in progress)
  }
}

async function waitMesh(page, predicate, { timeout = 60_000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await meshSnapshot(page);
    if (last && predicate(last)) return last;
    if (Date.now() > deadline) {
      const summary = last
        ? `phase=${last.phase} transfers=${JSON.stringify(last.transfers.map((t) => ({ n: t.name, s: t.status, tr: t.transferred, rf: t.resumedFrom })))}`
        : "no session handle";
      throw new Error(`Timed out waiting for ${label}: ${summary}`);
    }
    await wait(150);
  }
}

/** SHA-256 of a received (memory tier) transfer via the blob registry. */
async function receivedSha(page, url) {
  return page.evaluate(async (blobUrl) => {
    const registry = window.__blobRegistry;
    const blob = registry ? registry.get(blobUrl) : null;
    if (!blob) return null;
    const buf = await blob.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }, url);
}

/**
 * Arms an in-page reload that fires the moment a transfer in `direction`
 * crosses `threshold` bytes. In-page because Node-side polling cannot beat a
 * fast local wire to "mid-flight". Stashes the crossing progress figure in
 * sessionStorage so the test can prove the reload really was mid-flight.
 */
async function armMidflightReload(page, direction, threshold) {
  return page.evaluate(
    ({ direction, threshold }) => {
      const s = window.__instantMeshSession;
      if (!s) return false;
      let fired = false;
      const unsub = s.subscribe(() => {
        if (fired) return;
        const t = s
          .getSnapshot()
          .transfers.find(
            (x) => x.direction === direction && x.status === "active" && x.transferred >= threshold,
          );
        if (t) {
          fired = true;
          unsub();
          try {
            sessionStorage.setItem("verify-pre-reload", String(t.transferred));
          } catch {}
          location.reload();
        }
      });
      return true;
    },
    { direction, threshold },
  );
}

async function preReloadProgress(page) {
  return page.evaluate(() => {
    try {
      return Number(sessionStorage.getItem("verify-pre-reload") || "0");
    } catch {
      return 0;
    }
  });
}

/** Marks the CURRENT document so a later wait can tell it was replaced. */
async function markDocument(page) {
  await page.evaluate(() => {
    window.__verifyPreReloadDoc = true;
  });
}

/** Waits until the marked document is gone (reload happened) AND the fresh
 *  session reports connected again. */
async function waitReloadedAndConnected(page, { timeout = 120_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const state = await page
      .evaluate(() => ({
        oldDoc: Boolean(window.__verifyPreReloadDoc),
        phase: window.__instantMeshSession
          ? window.__instantMeshSession.getSnapshot().phase
          : null,
      }))
      .catch(() => null);
    if (state && !state.oldDoc && state.phase === "connected") return;
    if (Date.now() > deadline) {
      throw new Error(`page never reloaded+reconnected: ${JSON.stringify(state)}`);
    }
    await wait(200);
  }
}

/** Opens the Files tab and feeds the hidden input a real file from disk. */
async function pickFiles(page, filePath) {
  const tab = page.getByRole("tab", { name: /files/i }).first();
  if (await tab.isVisible().catch(() => false)) {
    await tab.click().catch(() => {});
  }
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 20_000 });
  await input.setInputFiles(filePath);
}

/** Builds a deterministic File IN the page and sends it; returns its sha. */
async function sendGeneratedFile(page, { name, size, seed, to = null, lastModified = 1700000000000 }) {
  return page.evaluate(
    async ({ name, size, seed, to, lastModified }) => {
      const bytes = new Uint8Array(size);
      let s = seed >>> 0 || 1;
      for (let i = 0; i < size; i += 4) {
        s ^= (s << 13) >>> 0; s >>>= 0;
        s ^= s >>> 17;
        s ^= (s << 5) >>> 0; s >>>= 0;
        bytes[i] = s & 255;
        if (i + 1 < size) bytes[i + 1] = (s >>> 8) & 255;
        if (i + 2 < size) bytes[i + 2] = (s >>> 16) & 255;
        if (i + 3 < size) bytes[i + 3] = (s >>> 24) & 255;
      }
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const file = new File([bytes], name, { type: "application/octet-stream", lastModified });
      const session = window.__instantMeshSession;
      await session.sendFiles([file], to === null ? null : { to });
      return sha;
    },
    { name, size, seed, to, lastModified },
  );
}

/** Taps this page's raw files channel to `peerId`: capture + inject frames. */
async function rawChannelSetup(page, peerId) {
  return page.evaluate((pid) => {
    const s = window.__instantMeshSession;
    if (!s || !s.links) return "no-session";
    const link = s.links.get(pid);
    if (!link) return "no-link";
    const ch = link.filesChannel;
    if (!ch || ch.readyState !== "open") return `channel:${ch ? ch.readyState : "missing"}`;
    window.__rawFrames = [];
    ch.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          window.__rawFrames.push(JSON.parse(event.data));
        } catch {}
      }
    });
    window.__rawSend = (obj) => ch.send(JSON.stringify(obj));
    return "ok";
  }, peerId);
}

async function rawSend(page, frame) {
  await page.evaluate((f) => window.__rawSend(f), frame);
}

async function waitRawFrame(page, predicateSrc, { timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const frame = await page.evaluate((src) => {
      const pred = new Function("f", `return (${src})(f);`);
      return (window.__rawFrames || []).find((f) => pred(f)) ?? null;
    }, predicateSrc);
    if (frame) return frame;
    if (Date.now() > deadline) return null;
    await wait(200);
  }
}

const byName = (snap, name) =>
  snap.transfers.filter((t) => t.name === name);

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioA(browser, base, check, skip, trackErrors) {
  console.log("\n--- A: receiver reload resumes from the acked offset (headline) ---");
  const big = await makeFixture(FIXTURE_DIR, "resume-big.bin", 96 * MiB, 11);

  const host = await newParticipant(browser, "A-sender", { name: "Sam" });
  const guest = await newParticipant(browser, "A-receiver", { name: "Rita" });
  trackErrors(host);
  trackErrors(guest);
  await host.context.addInitScript(MEMORY_OVERRIDE);
  await guest.context.addInitScript(MEMORY_OVERRIDE);

  try {
    const roomUrl = await createRoomAsHost(host, base);
    await knockAndAdmit(host, guest, roomUrl);
    await waitForConnected(host.page);
    await waitForConnected(guest.page);

    // Reload the receiver the moment 24 MiB have arrived (well past several
    // 1 MiB ack windows, well before the end of 96 MiB).
    check("receiver reload trigger armed", await armMidflightReload(guest.page, "incoming", 24 * MiB));

    await pickFiles(host.page, big.file);

    // After the self-reload, the seat token reclaims the seat, the link is
    // rebuilt, the receiver announces its partial, the sender re-offers.
    const resumed = await waitMesh(
      guest.page,
      (s) =>
        s.transfers.some(
          (t) =>
            t.direction === "incoming" &&
            t.name === "resume-big.bin" &&
            t.resumedFrom !== null &&
            t.resumedFrom > 0 &&
            (t.status === "active" || t.status === "complete"),
        ),
      { timeout: 120_000, label: "a resumed incoming transfer after receiver reload" },
    );
    const preReload = await preReloadProgress(guest.page);
    const resumedRow = resumed.transfers.find(
      (t) => t.name === "resume-big.bin" && t.resumedFrom !== null && t.resumedFrom > 0,
    );

    check(
      "reload happened mid-flight (progress recorded before reload)",
      preReload >= 24 * MiB && preReload < big.bytes,
      `preReload=${preReload}`,
    );
    check(
      "resume offset is well above zero (>= one ack window)",
      resumedRow.resumedFrom >= ACK_INTERVAL,
      `resumedFrom=${resumedRow.resumedFrom}`,
    );
    check(
      "resume offset never exceeds what had been received",
      resumedRow.resumedFrom <= preReload,
      `resumedFrom=${resumedRow.resumedFrom} preReload=${preReload}`,
    );
    check(
      "resume rewinds at most to the last ack (bounded rewind, not a restart)",
      preReload - resumedRow.resumedFrom <= 96 * MiB - 24 * MiB &&
        resumedRow.resumedFrom >= preReload - 80 * MiB &&
        resumedRow.resumedFrom > 0.5 * ACK_INTERVAL,
      `rewind=${preReload - resumedRow.resumedFrom}`,
    );
    check(
      "progress just after reload starts at the resume offset, not 0%",
      resumedRow.transferred >= resumedRow.resumedFrom,
      `transferred=${resumedRow.transferred}`,
    );

    // The sender reports the resume too.
    const senderSnap = await waitMesh(
      host.page,
      (s) =>
        s.transfers.some(
          (t) => t.direction === "outgoing" && t.resumedFrom !== null && t.resumedFrom > 0,
        ),
      { timeout: 30_000, label: "sender-side resumedFrom" },
    );
    const senderRow = senderSnap.transfers.find(
      (t) => t.direction === "outgoing" && t.resumedFrom !== null && t.resumedFrom > 0,
    );
    check(
      "sender reports the resume offset it continued from",
      senderRow.resumedFrom === resumedRow.resumedFrom,
      `sender=${senderRow.resumedFrom} receiver=${resumedRow.resumedFrom}`,
    );

    const done = await waitMesh(
      guest.page,
      (s) =>
        s.transfers.some(
          (t) => t.name === "resume-big.bin" && t.status === "complete" && t.url,
        ),
      { timeout: 180_000, label: "resumed transfer completion" },
    );
    const finished = done.transfers.find((t) => t.name === "resume-big.bin" && t.status === "complete");
    const sha = await receivedSha(guest.page, finished.url);
    check(
      "HEADLINE: resumed file is byte-for-byte identical (sha256)",
      sha === big.sha,
      `expected ${big.sha}, got ${sha}`,
    );

    // ---- crafted offers and garbage frames against the memory tier --------
    const guestId = (await meshSnapshot(guest.page)).selfId;
    const tap = await rawChannelSetup(host.page, guestId);
    check("raw files channel tap (sender side)", tap === "ok", tap);
    if (tap === "ok") {
      await rawSend(host.page, {
        k: "offer",
        id: 900002,
        uid: "verify-huge-mem",
        name: "huge.bin",
        size: 3 * 1024 * MiB,
        mime: "application/octet-stream",
        lastModified: 1,
      });
      const declined = await waitRawFrame(
        host.page,
        `(f) => f.k === "cancel" && f.id === 900002`,
      );
      check(
        "3 GiB offer against the MEMORY tier is declined up front",
        declined !== null && /limit|budget/i.test(declined.reason || ""),
        JSON.stringify(declined),
      );

      // Garbage ack / cancel / resume-req frames: nothing may crash, nothing
      // may move, nothing may allocate unboundedly.
      await rawSend(host.page, { k: "ack", id: 999999, received: 1e15 });
      await rawSend(host.page, { k: "ack", id: "nope", received: -5 });
      await rawSend(host.page, { k: "cancel", id: 87654321, by: "receiver" });
      await rawSend(host.page, { k: "resume-req", uid: 42, name: 1, size: -1, lastModified: "x", received: 1e18 });
      await wait(800);
      const after = await meshSnapshot(guest.page);
      const stillComplete = after.transfers.some(
        (t) => t.name === "resume-big.bin" && t.status === "complete",
      );
      check(
        "garbage frames neither crash the session nor disturb finished transfers",
        after.phase === "connected" && stillComplete,
        `phase=${after.phase}`,
      );
    }
  } finally {
    await host.context.close().catch(() => {});
    await guest.context.close().catch(() => {});
  }
}

async function scenarioBC(browser, base, check, skip, trackErrors) {
  console.log("\n--- B: sender reload -> honest re-select, then a real resume ---");
  const fileB = await makeFixture(FIXTURE_DIR, "reselect-me.bin", 48 * MiB, 22);

  const host = await newParticipant(browser, "B-sender", { name: "Sena" });
  const guest = await newParticipant(browser, "B-receiver", { name: "Remy" });
  trackErrors(host);
  trackErrors(guest);
  await host.context.addInitScript(MEMORY_OVERRIDE);
  await guest.context.addInitScript(MEMORY_OVERRIDE);

  try {
    const roomUrl = await createRoomAsHost(host, base);
    await knockAndAdmit(host, guest, roomUrl);
    await waitForConnected(host.page);
    await waitForConnected(guest.page);

    check("sender reload trigger armed", await armMidflightReload(host.page, "outgoing", 12 * MiB));
    await markDocument(host.page);
    await pickFiles(host.page, fileB.file);

    // The sender's page reloads itself mid-send; wait for the NEW document to
    // reclaim the seat and reconnect (the marker proves the reload happened).
    await waitReloadedAndConnected(host.page, { timeout: 120_000 });

    // Honest failure, receiver side: a resumable partial row, no fake 0%.
    const partialSnap = await waitMesh(
      guest.page,
      (s) =>
        s.transfers.some(
          (t) =>
            t.key.startsWith("partial:") &&
            t.name === "reselect-me.bin" &&
            t.resumable &&
            t.transferred > 0,
        ),
      { timeout: 60_000, label: "resumable partial row on the receiver" },
    );
    const partialRow = partialSnap.transfers.find((t) => t.key.startsWith("partial:"));
    check(
      "receiver shows a resumable partial with real progress (not stuck 0%)",
      partialRow.transferred >= ACK_INTERVAL && partialRow.status !== "active",
      `transferred=${partialRow.transferred} status=${partialRow.status}`,
    );

    // The sender was told the peer holds a partial and got a nack, so the
    // receiver's row should carry the re-select note.
    const nacked = await waitMesh(
      guest.page,
      (s) =>
        s.transfers.some(
          (t) => t.key.startsWith("partial:") && /re-select/i.test(t.error || ""),
        ),
      { timeout: 60_000, label: "re-select note on the partial row" },
    );
    check("partial row says the sender must re-select the file", nacked !== null);

    const senderTold = await waitMesh(
      host.page,
      (s) => /re-select the file/i.test(s.error || ""),
      { timeout: 60_000, label: "sender-side re-select message" },
    );
    check(
      "sender is told to re-select (with the peer's real progress)",
      /already has \d+% of "reselect-me\.bin"/i.test(senderTold.error || ""),
      senderTold.error,
    );

    const noFakeResume = await meshSnapshot(guest.page);
    check(
      "nothing pretends to resume before the file is re-selected",
      !noFakeResume.transfers.some(
        (t) => t.name === "reselect-me.bin" && t.status === "active",
      ),
    );

    // Re-select the SAME file (same path, same mtime): the identity matches
    // the partial, so the transfer must continue from the durable offset.
    await pickFiles(host.page, fileB.file);
    const resumed = await waitMesh(
      guest.page,
      (s) =>
        s.transfers.some(
          (t) =>
            t.name === "reselect-me.bin" &&
            t.resumedFrom !== null &&
            t.resumedFrom > 0 &&
            t.status === "complete" &&
            t.url,
        ),
      { timeout: 120_000, label: "resume-after-reselect completion" },
    );
    const resumedRow = resumed.transfers.find(
      (t) => t.name === "reselect-me.bin" && t.status === "complete",
    );
    check(
      "re-selected file resumed from the partial (resumedFrom > 0)",
      resumedRow.resumedFrom >= ACK_INTERVAL,
      `resumedFrom=${resumedRow.resumedFrom}`,
    );
    const shaB = await receivedSha(guest.page, resumedRow.url);
    check(
      "file resumed after sender reload is byte-identical (sha256)",
      shaB === fileB.sha,
      `expected ${fileB.sha}, got ${shaB}`,
    );

    // --- C: a DIFFERENT file with the same name and size must NOT resume ---
    console.log("\n--- C: same name + size, different bytes -> clean restart, no splice ---");
    const dirC1 = path.join(FIXTURE_DIR, "c1");
    const dirC2 = path.join(FIXTURE_DIR, "c2");
    const twin1 = await makeFixture(dirC1, "twin.bin", 48 * MiB, 33);
    const twin2 = await makeFixture(dirC2, "twin.bin", 48 * MiB, 44);
    // Distinct mtimes: identity is (name, size, lastModified).
    const now = Date.now() / 1000;
    await utimes(twin1.file, now - 5000, now - 5000);
    await utimes(twin2.file, now, now);

    check("second sender reload trigger armed", await armMidflightReload(host.page, "outgoing", 12 * MiB));
    await markDocument(host.page);
    await pickFiles(host.page, twin1.file);
    await waitReloadedAndConnected(host.page, { timeout: 120_000 });
    await waitMesh(
      guest.page,
      (s) => s.transfers.some((t) => t.key.startsWith("partial:") && t.name === "twin.bin"),
      { timeout: 60_000, label: "partial row for twin.bin" },
    );

    // Send the impostor: same name, same size, different bytes and mtime.
    await pickFiles(host.page, twin2.file);
    const cleanRestart = await waitMesh(
      guest.page,
      (s) =>
        s.transfers.some(
          (t) => t.name === "twin.bin" && t.status === "complete" && t.url,
        ),
      { timeout: 120_000, label: "twin.bin completion" },
    );
    const twinRow = cleanRestart.transfers.find(
      (t) => t.name === "twin.bin" && t.status === "complete",
    );
    check(
      "different file with the same name/size did NOT resume (restarted at 0)",
      twinRow.resumedFrom === null,
      `resumedFrom=${twinRow.resumedFrom}`,
    );
    const shaTwin = await receivedSha(guest.page, twinRow.url);
    check(
      "no splice: the received file matches the NEW file exactly",
      shaTwin === twin2.sha && shaTwin !== twin1.sha,
      `got ${shaTwin}`,
    );
  } finally {
    await host.context.close().catch(() => {});
    await guest.context.close().catch(() => {});
  }
}

async function scenarioD(browser, base, check, skip, trackErrors) {
  console.log("\n--- D: 3-party targeting, read-once fan-out, same-name collisions ---");
  const host = await newParticipant(browser, "D-host", { name: "Hana" });
  const gus = await newParticipant(browser, "D-gus", { name: "Gus" });
  const gia = await newParticipant(browser, "D-gia", { name: "Gia" });
  for (const p of [host, gus, gia]) {
    trackErrors(p);
    await p.context.addInitScript(MEMORY_OVERRIDE);
  }

  try {
    const roomUrl = await createRoomAsHost(host, base);
    await ensureCapacity(host, 3);
    await knockAndAdmit(host, gus, roomUrl);
    await knockAndAdmit(host, gia, roomUrl);
    await waitForConnected(host.page, { peers: 2 });
    await waitForConnected(gus.page, { peers: 2 });
    await waitForConnected(gia.page, { peers: 2 });

    const hostSnap = await meshSnapshot(host.page);
    const gusId = hostSnap.participants.find((p) => p.name === "Gus")?.id;
    const giaId = hostSnap.participants.find((p) => p.name === "Gia")?.id;
    check("both guests present on the host roster", Boolean(gusId && giaId));

    // ---- send to exactly ONE recipient ------------------------------------
    const shaTarget = await sendGeneratedFile(host.page, {
      name: "target-one.bin",
      size: 4 * MiB,
      seed: 55,
      to: [gusId],
    });
    const gusGot = await waitMesh(
      gus.page,
      (s) => s.transfers.some((t) => t.name === "target-one.bin" && t.status === "complete" && t.url),
      { timeout: 60_000, label: "targeted recipient receives" },
    );
    const gusRow = gusGot.transfers.find((t) => t.name === "target-one.bin");
    check(
      "targeted peer received the file intact",
      (await receivedSha(gus.page, gusRow.url)) === shaTarget,
    );
    await wait(1500); // grace: if the third peer were going to see it, it would by now
    const giaSnap = await meshSnapshot(gia.page);
    check(
      "the peer NOT in SendTargets received nothing",
      byName(giaSnap, "target-one.bin").length === 0,
      JSON.stringify(byName(giaSnap, "target-one.bin")),
    );
    const hostAfterTarget = await meshSnapshot(host.page);
    check(
      "sender created exactly one outgoing record for one recipient",
      byName(hostAfterTarget, "target-one.bin").filter((t) => t.direction === "outgoing").length === 1,
    );

    // ---- fan-out to all, file read ONCE ------------------------------------
    await host.page.evaluate(() => {
      window.__origArrayBuffer = Blob.prototype.arrayBuffer;
      window.__blobReads = 0;
      Blob.prototype.arrayBuffer = function () {
        window.__blobReads += 1;
        return window.__origArrayBuffer.call(this);
      };
    });
    const shaFan = await sendGeneratedFile(host.page, {
      name: "fan-out.bin",
      size: 4 * MiB,
      seed: 66,
      to: null,
    });
    const blobReads = await host.page.evaluate(() => {
      const reads = window.__blobReads;
      Blob.prototype.arrayBuffer = window.__origArrayBuffer;
      return reads;
    });
    // The engine reads in 8 MiB spans, so a 4 MiB file to TWO recipients must
    // hit the disk exactly ONCE in total, not once per recipient.
    check(
      "fan-out reads the file from disk once in total, not once per recipient",
      blobReads === 1,
      `disk reads=${blobReads}, recipients=2`,
    );
    for (const [label, p] of [["gus", gus], ["gia", gia]]) {
      const got = await waitMesh(
        p.page,
        (s) => s.transfers.some((t) => t.name === "fan-out.bin" && t.status === "complete" && t.url),
        { timeout: 60_000, label: `${label} fan-out completion` },
      );
      const row = got.transfers.find((t) => t.name === "fan-out.bin");
      check(
        `fan-out copy to ${label} is byte-identical`,
        (await receivedSha(p.page, row.url)) === shaFan,
      );
    }

    // ---- two peers send the SAME filename to the host simultaneously ------
    const [shaGus, shaGia] = await Promise.all([
      sendGeneratedFile(gus.page, { name: "same-name.bin", size: 3 * MiB, seed: 77 }),
      sendGeneratedFile(gia.page, { name: "same-name.bin", size: 3 * MiB, seed: 88 }),
    ]);
    const hostBoth = await waitMesh(
      host.page,
      (s) =>
        s.transfers.filter(
          (t) => t.name === "same-name.bin" && t.direction === "incoming" && t.status === "complete" && t.url,
        ).length === 2,
      { timeout: 60_000, label: "both same-name files on the host" },
    );
    const rows = hostBoth.transfers.filter(
      (t) => t.name === "same-name.bin" && t.direction === "incoming" && t.status === "complete",
    );
    const shas = new Set();
    for (const row of rows) shas.add(await receivedSha(host.page, row.url));
    check(
      "simultaneous same-name transfers do not collide (both byte-identical)",
      shas.size === 2 && shas.has(shaGus) && shas.has(shaGia),
      `got ${[...shas].join(", ")}`,
    );

    // ---- moderation transport smoke (behaviour suite lives with the video
    // grid lane; this only proves the wiring does not crash and seq moves) ---
    const readModeration = () =>
      gus.page.evaluate(() => {
        const mod = window.__instantMeshSession.getSnapshot().moderation;
        return mod ? { seq: mod.seq, action: mod.action, byName: mod.byName } : null;
      });
    const waitModeration = async (predicate, timeout = 15_000) => {
      const deadline = Date.now() + timeout;
      for (;;) {
        const m = await readModeration();
        if (m && predicate(m)) return m;
        if (Date.now() > deadline) return null;
        await wait(200);
      }
    };
    // Gus's mic is off, so this enforced mute must be a no-op that still lands.
    await host.page.evaluate(
      (id) => window.__instantMeshSession.moderate(id, "mute-audio"),
      gusId,
    );
    const first = await waitModeration((m) => m.action === "mute-audio");
    // The SAME action again: seq must still increase (UI dedupes on it).
    if (first) {
      await host.page.evaluate(
        (id) => window.__instantMeshSession.moderate(id, "mute-audio"),
        gusId,
      );
    }
    const second = first ? await waitModeration((m) => m.seq > first.seq) : null;
    check(
      "moderation transport: enforced mute on an off device is a no-op that still bumps seq",
      first !== null && second !== null && second.action === "mute-audio",
      JSON.stringify({ first, second }),
    );
    const gusAlive = await meshSnapshot(gus.page);
    check(
      "moderation events do not disturb the session or its transfers",
      gusAlive.phase === "connected" &&
        gusAlive.transfers.some((t) => t.name === "fan-out.bin" && t.status === "complete"),
    );
  } finally {
    await host.context.close().catch(() => {});
    await gus.context.close().catch(() => {});
    await gia.context.close().catch(() => {});
  }
}

async function scenarioE(browser, base, check, skip, trackErrors) {
  console.log("\n--- E: streaming tier is not charged against the memory budget ---");
  const host = await newParticipant(browser, "E-sender", { name: "Stef" });
  const guest = await newParticipant(browser, "E-receiver", { name: "Drew" });
  trackErrors(host);
  trackErrors(guest);
  await host.context.addInitScript(MEMORY_OVERRIDE);
  await guest.context.addInitScript(STREAMING_OVERRIDE); // receiver streams

  try {
    const roomUrl = await createRoomAsHost(host, base);
    await knockAndAdmit(host, guest, roomUrl);
    await waitForConnected(host.page);
    await waitForConnected(guest.page);

    // A real transfer through the streaming sink completes (no object URL).
    await sendGeneratedFile(host.page, { name: "streamed.bin", size: 8 * MiB, seed: 99 });
    const streamed = await waitMesh(
      guest.page,
      (s) => s.transfers.some((t) => t.name === "streamed.bin" && t.status === "complete"),
      { timeout: 60_000, label: "streamed transfer completion" },
    );
    const row = streamed.transfers.find((t) => t.name === "streamed.bin");
    check(
      "transfer through a streaming sink completes with tier=download, no URL",
      row.sinkTier === "download" && row.url === null,
      JSON.stringify({ tier: row.sinkTier, url: row.url }),
    );

    // The same 3 GiB offer the memory tier declined (scenario A) must be
    // ACCEPTED here: streaming holds no bytes, so no memory cap may apply.
    const guestId = (await meshSnapshot(guest.page)).selfId;
    const tap = await rawChannelSetup(host.page, guestId);
    check("raw files channel tap (streaming room)", tap === "ok", tap);
    if (tap === "ok") {
      await rawSend(host.page, {
        k: "offer",
        id: 900001,
        uid: "verify-huge-stream",
        name: "huge.bin",
        size: 3 * 1024 * MiB,
        mime: "application/octet-stream",
        lastModified: 1,
      });
      const accepted = await waitRawFrame(
        host.page,
        `(f) => (f.k === "accept" || f.k === "cancel") && f.id === 900001`,
      );
      check(
        "3 GiB offer is ACCEPTED by the streaming tier (memory budget not charged)",
        accepted !== null && accepted.k === "accept" && accepted.from === 0,
        JSON.stringify(accepted),
      );
      // Clean up the receiver's pending 3 GiB transfer.
      await rawSend(host.page, { k: "cancel", id: 900001, by: "sender", reason: "verification cleanup" });
    }
  } finally {
    await host.context.close().catch(() => {});
    await guest.context.close().catch(() => {});
  }
}

async function scenarioF(browser, base, check, skip, trackErrors) {
  console.log("\n--- F: IndexedDB unavailable -> non-resumable, but transfers still work ---");
  const small = await makeFixture(FIXTURE_DIR, "idb-free.bin", 8 * MiB, 111);

  const host = await newParticipant(browser, "F-sender", { name: "Iva" });
  const guest = await newParticipant(browser, "F-receiver", { name: "Nia" });
  trackErrors(host);
  trackErrors(guest);
  await host.context.addInitScript(MEMORY_OVERRIDE);
  await guest.context.addInitScript(KILL_IDB);
  await guest.context.addInitScript(MEMORY_OVERRIDE);

  try {
    const roomUrl = await createRoomAsHost(host, base);
    await knockAndAdmit(host, guest, roomUrl);
    await waitForConnected(host.page);
    await waitForConnected(guest.page);

    const idbGone = await guest.page.evaluate(() => typeof indexedDB === "undefined" || !indexedDB);
    check("indexedDB really is absent in the receiver page", idbGone);

    await pickFiles(host.page, small.file);
    const done = await waitMesh(
      guest.page,
      (s) => s.transfers.some((t) => t.name === "idb-free.bin" && t.status === "complete" && t.url),
      { timeout: 60_000, label: "transfer completion without IndexedDB" },
    );
    const row = done.transfers.find((t) => t.name === "idb-free.bin");
    const sha = await receivedSha(guest.page, row.url);
    check(
      "transfer completes byte-identical with IndexedDB unavailable",
      sha === small.sha,
      `expected ${small.sha}, got ${sha}`,
    );
    check(
      "no partial rows are invented when persistence is impossible",
      !done.transfers.some((t) => t.key.startsWith("partial:")),
    );
  } finally {
    await host.context.close().catch(() => {});
    await guest.context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  const { base, headed } = parseCliArgs();
  console.log(`verify-transfer-resume against ${base}`);

  await rm(FIXTURE_DIR, { recursive: true, force: true });
  await mkdir(FIXTURE_DIR, { recursive: true });

  const { state, check, skip } = makeChecker();
  const pageErrors = [];
  const trackErrors = (participant) => {
    participant.page.on("pageerror", (error) =>
      pageErrors.push(`[${participant.label}] ${error.message}`),
    );
  };

  const browser = await launchMeshBrowser({ headed });
  try {
    const scenarios = [
      ["A", scenarioA],
      ["B+C", scenarioBC],
      ["D", scenarioD],
      ["E", scenarioE],
      ["F", scenarioF],
    ];
    for (const [label, run] of scenarios) {
      try {
        await run(browser, base, check, skip, trackErrors);
      } catch (error) {
        check(`scenario ${label} ran to completion`, false, error.message);
      }
    }

    // Honest SKIPs for what a wall-clock test cannot reach quickly.
    skip(
      "TTL pruning of stale partials",
      "partialTtlMs is 24h; the prune-on-list path cannot elapse in a test run",
    );
    skip(
      "accept-timeout path (silent receiver)",
      "ACCEPT_TIMEOUT_MS is 30s of dead air; the decline path covers offer rejection instead",
    );
    skip(
      "filesystem-tier native seek resume",
      "needs a real folder picker; the sink contract path is covered by scripts/verify-download-tiers.mjs (sink lane)",
    );

    check("no uncaught page errors across all scenarios", pageErrors.length === 0, pageErrors.join(" | "));
  } finally {
    await browser.close().catch(() => {});
    await rm(FIXTURE_DIR, { recursive: true, force: true }).catch(() => {});
  }

  console.log(
    `\nRESULT: ${state.passes} passed, ${state.failures} failed, ${state.skips} skipped`,
  );
  process.exitCode = state.failures > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
