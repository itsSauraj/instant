/**
 * Exercises the signalling route's security invariants against a running dev
 * server. Not a unit-test suite -- it drives the real HTTP surface.
 *
 *   node scripts/verify-signalling.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const roomId = () =>
  Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("");

/** Opens an SSE stream and collects events into an array as they arrive. */
async function open(room) {
  const controller = new AbortController();
  const response = await fetch(`${BASE}/api/signal/${room}`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`GET returned ${response.status}`);

  const peer = { events: [], closed: false, close: () => controller.abort(), creds: null };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  peer.done = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, i).replace(/^data:\s*/gm, "");
          buffer = buffer.slice(i + 2);
          const event = JSON.parse(raw);
          if (event.t === "ping") continue;
          if (event.t === "welcome") peer.creds = { id: event.peerId, secret: event.secret };
          peer.events.push(event);
        }
      }
    } catch {
      // Aborted by the test or closed by the server.
    }
    peer.closed = true;
  })();

  return peer;
}

const post = (room, creds, body) =>
  fetch(`${BASE}/api/signal/${room}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-peer-id": creds?.id ?? "",
      "x-peer-secret": creds?.secret ?? "",
    },
    body: JSON.stringify(body),
  });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(300);

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function testPairingAndRoles() {
  console.log("\nPairing and role assignment");
  const room = roomId();
  const a = await open(room);
  await settle();
  const b = await open(room);
  await settle();

  check("first peer is the initiator", a.events[0]?.role === "initiator", a.events[0]?.role);
  check("first peer sees an empty room", a.events[0]?.peerPresent === false);
  check("second peer is the responder", b.events[0]?.role === "responder", b.events[0]?.role);
  check("second peer sees the first", b.events[0]?.peerPresent === true);
  check("initiator is told the peer joined", a.events.some((e) => e.t === "peer-joined"));

  a.close();
  b.close();
  await settle();
}

async function testThirdPeerRefused() {
  console.log("\nA third participant is refused");
  const room = roomId();
  const a = await open(room);
  const b = await open(room);
  await settle();

  const c = await open(room);
  await settle();

  check("third peer gets no welcome", !c.events.some((e) => e.t === "welcome"));
  check(
    "third peer is told the room is full",
    c.events.some((e) => e.t === "peer-left" && e.reason === "room-full"),
    JSON.stringify(c.events),
  );
  check("third peer's stream is closed", c.closed);
  check("the established pair is untouched", !a.closed && !b.closed);
  check("no peer-left leaked to the pair", !a.events.some((e) => e.t === "peer-left"));

  a.close();
  b.close();
  await settle();
}

async function testRelayIsPointToPoint() {
  console.log("\nRelay delivers to the peer only");
  const room = roomId();
  const a = await open(room);
  const b = await open(room);
  await settle();

  const payload = { kind: "candidate", candidate: { candidate: "probe" } };
  const response = await post(room, a.creds, { t: "signal", data: payload });
  await settle();

  check("relay accepted", response.status === 200, String(response.status));
  check(
    "peer received the signal",
    b.events.some((e) => e.t === "signal" && e.data?.candidate?.candidate === "probe"),
  );
  check("sender did not receive its own signal", !a.events.some((e) => e.t === "signal"));

  a.close();
  b.close();
  await settle();
}

async function testForgedCredentials() {
  console.log("\nForged credentials are rejected");
  const room = roomId();
  const a = await open(room);
  const b = await open(room);
  await settle();

  const wrongSecret = await post(
    room,
    { id: a.creds.id, secret: "0".repeat(a.creds.secret.length) },
    { t: "signal", data: { kind: "candidate", candidate: null } },
  );
  const unknownPeer = await post(
    room,
    { id: "zzzzzzzzzzzzzzzz", secret: a.creds.secret },
    { t: "signal", data: { kind: "candidate", candidate: null } },
  );
  const noHeaders = await fetch(`${BASE}/api/signal/${room}`, {
    method: "POST",
    body: JSON.stringify({ t: "signal", data: { kind: "candidate", candidate: null } }),
  });
  await settle();

  check("wrong secret is 401", wrongSecret.status === 401, String(wrongSecret.status));
  check("unknown peer id is 401", unknownPeer.status === 401, String(unknownPeer.status));
  check("missing headers is 401", noHeaders.status === 401, String(noHeaders.status));
  check("nothing was delivered to the peer", !b.events.some((e) => e.t === "signal"));

  a.close();
  b.close();
  await settle();
}

async function testDeliberateHangUpResetsBoth() {
  console.log("\nDeliberate hang-up resets both sides");
  const room = roomId();
  const a = await open(room); // first in: the host / initiator
  const b = await open(room); // second in: the guest / responder
  await settle();

  // Which rule is live? Originally either peer could post "bye"; with host
  // authority the guest's "bye" is refused (403) until the host grants it.
  const guestBye = await post(room, b.creds, { t: "bye" });
  await settle();

  let survivor;
  if (guestBye.status === 403) {
    console.log("  INFO  host-authority rule detected: ungranted guest bye is refused");
    check("an ungranted guest bye is refused with 403", true);
    check("a refused bye leaves the room intact", !a.closed && !b.closed);

    // The host may always end the session deliberately.
    const hostBye = await post(room, a.creds, { t: "bye" });
    await settle();
    check("the host's bye is accepted", hostBye.status === 200, String(hostBye.status));
    survivor = b;
  } else {
    check(
      "a peer's bye is accepted under the either-side-may-end rule",
      guestBye.status === 200,
      String(guestBye.status),
    );
    survivor = a;
  }

  check(
    "survivor is told the peer ended it",
    survivor.events.some((e) => e.t === "peer-left" && e.reason === "peer-ended"),
    JSON.stringify(survivor.events.filter((e) => e.t === "peer-left")),
  );
  check("survivor's stream is closed", survivor.closed);

  // The room must be gone, not merely half-empty.
  const late = await post(room, survivor.creds, {
    t: "signal",
    data: { kind: "candidate", candidate: null },
  });
  check("the room no longer exists", late.status === 410, String(late.status));

  const rejoin = await open(room);
  await settle();
  check(
    "a sealed code is retired, not recycled into a new lobby",
    rejoin.events.some((e) => e.t === "peer-left" && e.reason === "session-over"),
    JSON.stringify(rejoin.events),
  );
  check("the retired code grants no welcome", !rejoin.events.some((e) => e.t === "welcome"));
  rejoin.close();
  a.close();
  b.close();
  await settle();
}

async function testLobbyRefreshStillWorks() {
  console.log("\nRefreshing while alone in the lobby still works");
  const room = roomId();
  const a1 = await open(room);
  await settle();
  check("first visit is welcomed", a1.events[0]?.t === "welcome");

  a1.close(); // simulates F5 before anyone joined
  await wait(700);

  const a2 = await open(room);
  await settle();
  check(
    "the same code is re-usable because it never sealed",
    a2.events[0]?.t === "welcome" && a2.events[0]?.role === "initiator",
    JSON.stringify(a2.events),
  );

  a2.close();
  await settle();
}

async function testDroppedStreamResetsPeer() {
  console.log("\nAn abandoned tab resets the other side");
  const room = roomId();
  const a = await open(room);
  const b = await open(room);
  await settle();

  b.close(); // simulates closing the tab: no "bye", just a dead stream
  await wait(700);

  check(
    "survivor is told the peer left",
    a.events.some((e) => e.t === "peer-left" && e.reason === "peer-left"),
    JSON.stringify(a.events.filter((e) => e.t === "peer-left")),
  );
  check("survivor's stream is closed", a.closed);

  a.close();
  await settle();
}

async function testInputValidation() {
  console.log("\nInput validation");
  const room = roomId();
  const a = await open(room);
  await settle();

  const badRoom = await fetch(`${BASE}/api/signal/not-a-real-room-id`, {
    headers: { accept: "text/event-stream" },
  });
  const badJson = await post(room, a.creds, undefined);
  const badKind = await post(room, a.creds, { t: "signal", data: { kind: "evil" } });
  const oversized = await post(room, a.creds, {
    t: "signal",
    data: { kind: "description", description: { type: "offer", sdp: "x".repeat(200_000) } },
  });

  check("malformed room id is 400", badRoom.status === 400, String(badRoom.status));
  check("unparseable body is 400", badJson.status === 400, String(badJson.status));
  check("unknown signal kind is 400", badKind.status === 400, String(badKind.status));
  check("oversized payload is 413", oversized.status === 413, String(oversized.status));

  a.close();
  await settle();
}

console.log(`Verifying signalling at ${BASE}`);
await testPairingAndRoles();
await testThirdPeerRefused();
await testRelayIsPointToPoint();
await testForgedCredentials();
await testDeliberateHangUpResetsBoth();
await testLobbyRefreshStillWorks();
await testDroppedStreamResetsPeer();
await testInputValidation();

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
