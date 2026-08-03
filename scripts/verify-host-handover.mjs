/**
 * TRANSPORT-lane verification: clean-close error hygiene + host handover.
 *
 * What is proven, with real browser runs:
 *  1. CLEAN CLOSE (3 participants): when the host closes the session, every
 *     survivor's terminal screen shows the deliberate-close wording and NO
 *     "data channel reported an error" (the false alarm this suite pinned).
 *  2. GENUINE FAILURE: killing one side's RTCPeerConnection out-of-band (no
 *     authoritative signalling event) still surfaces a channel error on the
 *     survivor -- errors are deferred past the close-reason grace, not muted.
 *  3. HOST HANDOVER: transferHost() moves host powers via the authoritative
 *     roster (isHost), the new host is notified exactly once per handover
 *     (snapshot.hostChange, de-duplicated by seq), seq advances on a REPEAT
 *     handover, a demoted host's host-only calls are inert, and an ex-host
 *     who leave()s ends with isHost === false (no local re-assertion).
 *
 * Usage:  node scripts/verify-host-handover.mjs [baseUrl] [--headed]
 * Default base is http://127.0.0.1:3111 (production). Tests 2 and 3 need the
 * dev-only window handles (__instantMeshSession / __instantPeerConnections),
 * so against a production bundle they SKIP; run against a dev server (e.g.
 * http://127.0.0.1:3132) for full coverage. Test 1 runs everywhere.
 *
 * ASCII-only, per scripts/mesh-shared.mjs.
 */

import {
  closeRoomAsHost,
  createRoomAsHost,
  describesDeliberateClose,
  containsSpuriousError,
  ensureCapacity,
  knockAndAdmit,
  launchMeshBrowser,
  makeChecker,
  newParticipant,
  parseCliArgs,
  shot,
  terminalText,
  wait,
  waitForConnected,
  waitForLinksConnected,
} from "./mesh-shared.mjs";

const { base, headed } = parseCliArgs();
const { state, check, skip } = makeChecker();

/** Reads the transport-relevant slice of the dev-only session snapshot. */
async function snap(page) {
  return page.evaluate(() => {
    const session = window.__instantMeshSession;
    if (!session) return null;
    const s = session.getSnapshot();
    return {
      phase: s.phase,
      isHost: s.isHost,
      endReason: s.endReason,
      error: s.error,
      hostChange: s.hostChange ?? null,
      self: s.self ? { id: s.self.id, name: s.self.name } : null,
      participants: s.participants.map((p) => ({ id: p.id, name: p.name, isHost: p.isHost })),
    };
  });
}

/** Polls the snapshot until `predicate` passes; returns the last snapshot. */
async function waitForSnap(page, predicate, { timeout = 15_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await snap(page).catch(() => null);
    if (last && predicate(last)) return { ok: true, snap: last };
    if (Date.now() > deadline) return { ok: false, snap: last };
    await wait(interval);
  }
}

const describe = (s) =>
  s
    ? `phase=${s.phase} isHost=${s.isHost} hostChange=${JSON.stringify(s.hostChange)}`
    : "no session handle";

/**
 * Waits until `links` peer connections are up. The strong check reads the
 * dev-only __instantPeerConnections handle; a production bundle does not
 * expose it, so there the connection badge (weaker, but real) stands in.
 */
async function waitForMesh(page, links) {
  const hasHandle = await page
    .evaluate(() => window.__instantPeerConnections instanceof Map)
    .catch(() => false);
  if (hasHandle) {
    await waitForLinksConnected(page, links);
  } else {
    await waitForConnected(page, { peers: links });
  }
}

async function seatTrio(browser, names, { prep } = {}) {
  const host = await newParticipant(browser, "host", { name: names[0] });
  const g1 = await newParticipant(browser, "guest1", { name: names[1] });
  const g2 = await newParticipant(browser, "guest2", { name: names[2] });
  if (prep) await prep({ host, g1, g2 });
  const roomUrl = await createRoomAsHost(host, base);
  await ensureCapacity(host, 3);
  await knockAndAdmit(host, g1, roomUrl);
  await knockAndAdmit(host, g2, roomUrl);
  await waitForMesh(host.page, 2);
  await waitForMesh(g1.page, 2);
  await waitForMesh(g2.page, 2);
  return { host, g1, g2, roomUrl };
}

async function closeAll(...participants) {
  for (const p of participants) {
    await p.context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 1. Clean close: 3 participants, host closes, survivors stay error-free.
// ---------------------------------------------------------------------------
async function testCleanClose(browser) {
  console.log("\n[1] clean close: host ends a 3-person session");
  const { host, g1, g2 } = await seatTrio(browser, ["Hana Host", "Aria One", "Bo Two"]);
  try {
    await closeRoomAsHost(host);

    for (const guest of [g1, g2]) {
      const first = await terminalText(guest.page);
      check(
        `${guest.label}: terminal shows the deliberate-close wording`,
        describesDeliberateClose(first),
        first,
      );
      // The false error historically raced the authoritative `ended` by a few
      // hundred ms, and the link grace timer is 1500 ms: re-read after that
      // whole window so a late-arriving error cannot slip past the assertion.
      await wait(2500);
      const settled = await terminalText(guest.page);
      check(
        `${guest.label}: no data-channel error on the terminal screen`,
        !containsSpuriousError(settled),
        settled,
      );
      await shot(guest.page, `handover-clean-close-${guest.label}.png`);
    }

    const hostText = await terminalText(host.page);
    check(
      "host: own terminal shows the deliberate-close wording",
      describesDeliberateClose(hostText),
      hostText,
    );
    check("host: no data-channel error either", !containsSpuriousError(hostText), hostText);
  } finally {
    await closeAll(host, g1, g2);
  }
}

// ---------------------------------------------------------------------------
// 1b. Clean close under signalling lag: the adversarial ordering.
//
// On loopback the authoritative `ended` beats the host's SCTP teardown, so the
// links are destroyed before any channel event fires and the bug cannot show.
// In the real world the orders flip: the P2P abort lands instantly while the
// `ended` event crosses the network. CDP latency emulation recreates exactly
// that skew -- it delays the browser's fetch/SSE traffic but NOT WebRTC, so
// the survivor's channels die seconds before the reason arrives.
// ---------------------------------------------------------------------------
/**
 * Installs a fetch wrapper (before first paint) that pipes the signalling SSE
 * body through a delaying TransformStream. CDP network emulation cannot do
 * this: latency only delays request starts and throughput shaping does not
 * touch an in-flight streamed response. The wrapper delays each chunk by
 * `window.__sseDelayMs` -- 0 until a test raises it -- so the authoritative
 * `ended` can be made to trail the P2P teardown by any margin, while WebRTC
 * (not routed through fetch) stays instant. Exactly the real-world skew.
 */
async function installSseDelay(page) {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.__sseDelayMs = 0;
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      const response = await original(input, init);
      const isSignalStream =
        /\/api\/signal\//.test(url) && (!init || (init.method ?? "GET") === "GET");
      if (!isSignalStream || !response.body) return response;
      const delayed = response.body.pipeThrough(
        new TransformStream({
          async transform(chunk, controller) {
            const delay = window.__sseDelayMs;
            if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(delayed, { status: response.status, headers: response.headers });
    };
  });
}

const setSseDelay = (page, ms) =>
  page.evaluate((value) => {
    window.__sseDelayMs = value;
  }, ms);

async function testCleanCloseUnderLag(browser) {
  console.log("\n[1b] clean close with the ended event lagging the channel death");
  const { host, g1, g2 } = await seatTrio(browser, ["Hank Host", "Cy Three", "Dee Four"], {
    prep: ({ g2: lagged }) => installSseDelay(lagged.page),
  });
  try {
    // Everything connected; now make g2's signalling slow, so the channel
    // death goes locally unexplained for longer than the whole close-reason
    // grace window -- the worst case.
    await setSseDelay(g2.page, 3500);
    await wait(300);

    await closeRoomAsHost(host);

    const first = await terminalText(g2.page);
    check(
      "lagged survivor: terminal shows the deliberate-close wording",
      describesDeliberateClose(first),
      first,
    );
    await wait(2500);
    const settled = await terminalText(g2.page);
    check(
      "lagged survivor: no data-channel error despite the adversarial ordering",
      !containsSpuriousError(settled),
      settled,
    );
    await shot(g2.page, "handover-clean-close-lagged.png");
  } finally {
    await closeAll(host, g1, g2);
  }
}

// ---------------------------------------------------------------------------
// 2. Genuine transport failure must still surface an error.
// ---------------------------------------------------------------------------
async function testGenuineFailure(browser) {
  console.log("\n[2] genuine failure: peer connection killed with no goodbye");
  const host = await newParticipant(browser, "survivor", { name: "Sana Stays" });
  const guest = await newParticipant(browser, "vanisher", { name: "Vik Vanishes" });
  try {
    const roomUrl = await createRoomAsHost(host, base);
    await knockAndAdmit(host, guest, roomUrl);
    await waitForMesh(host.page, 1);
    await waitForMesh(guest.page, 1);

    const hasHandle = await guest.page.evaluate(
      () => window.__instantPeerConnections instanceof Map && window.__instantPeerConnections.size > 0,
    );
    if (!hasHandle) {
      skip(
        "genuine channel failure still surfaces an error",
        "__instantPeerConnections handle unavailable (production bundle?)",
      );
      return;
    }

    // Kill the guest's RTCPeerConnection WITHOUT any signalling goodbye: the
    // guest's SSE stream stays alive, so no authoritative event will excuse
    // the survivor's dead channels. This must surface as a real error there.
    await guest.page.evaluate(() => {
      for (const pc of window.__instantPeerConnections.values()) pc.close();
    });

    const deadline = Date.now() + 12_000;
    let seen = false;
    let lastBody = "";
    while (Date.now() < deadline) {
      lastBody = await host.page
        .locator("body")
        .innerText()
        .catch(() => "");
      if (/reported an error/i.test(lastBody)) {
        seen = true;
        break;
      }
      await wait(150);
    }
    check(
      "survivor of a genuine channel death still sees the error",
      seen,
      seen ? undefined : `never appeared; body tail: ${lastBody.slice(-200)}`,
    );
    if (seen) await shot(host.page, "handover-genuine-failure-banner.png");

    const s = await snap(host.page);
    if (s) {
      check(
        "the genuine error is a banner, not a session end",
        s.phase !== "ended",
        describe(s),
      );
    }
  } finally {
    await closeAll(host, guest);
  }
}

// ---------------------------------------------------------------------------
// 3. Host handover: powers move via the roster, notification via hostChange.
// ---------------------------------------------------------------------------
async function testHandover(browser) {
  console.log("\n[3] host handover: transfer, repeat transfer, ex-host leaves");
  const { host, g1, g2 } = await seatTrio(browser, ["Hoda Host", "Nia New", "Odo Next"]);
  try {
    const hostSnap = await snap(host.page);
    if (!hostSnap) {
      skip("host handover suite", "__instantMeshSession handle unavailable (production bundle?)");
      return;
    }
    const hasApi = await host.page.evaluate(
      () => typeof window.__instantMeshSession?.transferHost === "function",
    );
    if (!hasApi) {
      skip("host handover suite", "MeshSession.transferHost missing in served bundle");
      return;
    }

    check("host starts with host powers", hostSnap.isHost === true, describe(hostSnap));
    const idOf = (name) => hostSnap.participants.find((p) => p.name === name)?.id;
    const g1Id = idOf("Nia New");
    const g2Id = idOf("Odo Next");
    if (!g1Id || !g2Id) {
      check("guest peer ids resolvable from the host roster", false, JSON.stringify(hostSnap.participants));
      return;
    }

    // --- first handover: host -> g1 --------------------------------------
    await host.page.evaluate((id) => window.__instantMeshSession.transferHost(id), g1Id);

    const g1Host = await waitForSnap(g1.page, (s) => s.isHost === true);
    check("new host gains host powers (roster-driven isHost)", g1Host.ok, describe(g1Host.snap));
    const n1 = g1Host.snap?.hostChange;
    check(
      "new host is TOLD: hostChange { becameHost: true, byChoice: true }",
      Boolean(n1 && n1.becameHost === true && n1.byChoice === true && n1.peerId === g1Id),
      JSON.stringify(n1),
    );
    check("new host's notification starts at seq 1", n1?.seq === 1, JSON.stringify(n1));

    const oldHost = await waitForSnap(host.page, (s) => s.isHost === false);
    check("old host loses host powers locally", oldHost.ok, describe(oldHost.snap));
    const h1 = oldHost.snap?.hostChange;
    check(
      "old host's copy is a plain notification (becameHost: false)",
      Boolean(h1 && h1.becameHost === false && h1.peerId === g1Id),
      JSON.stringify(h1),
    );

    // --- notified exactly once: seq must NOT move without a new event -----
    await wait(2000);
    const g1Again = await snap(g1.page);
    check(
      "new host notified exactly once (seq stable with no new event)",
      g1Again?.hostChange?.seq === 1,
      describe(g1Again),
    );

    // --- demoted host's host-only calls are inert -------------------------
    await host.page.evaluate((id) => window.__instantMeshSession.transferHost(id), g2Id);
    await wait(2000);
    const g2Probe = await snap(g2.page);
    const g1Still = await snap(g1.page);
    check(
      "demoted host cannot hand the room onward (guarded no-op)",
      g2Probe?.isHost === false && g1Still?.isHost === true,
      `g2 ${describe(g2Probe)} | g1 ${describe(g1Still)}`,
    );
    check(
      "no phantom notification from the refused attempt",
      (g2Probe?.hostChange?.seq ?? 0) <= 1 && g1Still?.hostChange?.seq === 1,
      `g2 ${JSON.stringify(g2Probe?.hostChange)} | g1 ${JSON.stringify(g1Still?.hostChange)}`,
    );

    // --- repeat handover: g1 -> g2; seq must ADVANCE ----------------------
    await g1.page.evaluate((id) => window.__instantMeshSession.transferHost(id), g2Id);
    const g2Host = await waitForSnap(g2.page, (s) => s.isHost === true);
    check("second handover moves host powers again", g2Host.ok, describe(g2Host.snap));
    const n2 = g2Host.snap?.hostChange;
    check(
      "seq advances on the repeat handover (2nd event not swallowed)",
      Boolean(n2 && n2.seq === 2 && n2.becameHost === true && n2.peerId === g2Id),
      JSON.stringify(n2),
    );
    const g1After = await waitForSnap(g1.page, (s) => s.isHost === false);
    check(
      "previous host demoted again, seq advanced in their copy too",
      g1After.ok && g1After.snap?.hostChange?.seq === 2 && g1After.snap?.hostChange?.becameHost === false,
      describe(g1After.snap),
    );
    await shot(g2.page, "handover-new-host.png");

    // --- the original host leaves; must not re-assert host locally --------
    // end() deletes the dev handle, so hold the reference and read the final
    // snapshot in the same evaluation -- end() is synchronous.
    const hostGone = await host.page.evaluate(() => {
      const session = window.__instantMeshSession;
      session.leave();
      const s = session.getSnapshot();
      return { phase: s.phase, isHost: s.isHost, endReason: s.endReason };
    });
    check(
      "ex-host who leave()s ends with self-left and isHost still false",
      hostGone.phase === "ended" &&
        hostGone.endReason === "self-left" &&
        hostGone.isHost === false,
      JSON.stringify(hostGone),
    );

    const survivors = await waitForSnap(g2.page, (s) => s.participants.length === 1);
    check(
      "room survives the ex-host's departure with the transferred host intact",
      survivors.ok && survivors.snap?.isHost === true,
      describe(survivors.snap),
    );
  } finally {
    await closeAll(host, g1, g2);
  }
}

// ---------------------------------------------------------------------------
async function main() {
  console.log(`verify-host-handover against ${base}`);
  const browser = await launchMeshBrowser({ headed });
  try {
    await testCleanClose(browser);
    await testCleanCloseUnderLag(browser);
    await testGenuineFailure(browser);
    await testHandover(browser);
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(
    `\nRESULT pass=${state.passes} fail=${state.failures} skip=${state.skips}`,
  );
  process.exit(state.failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`FATAL ${error?.stack ?? error}`);
  process.exit(1);
});
