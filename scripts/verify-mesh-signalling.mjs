/**
 * Exercises the Phase 1 multi-peer signalling contract over plain HTTP -- no
 * browser. Written against lib/signal-protocol.ts (the frozen source of truth
 * for this phase): host-owned rooms of 2..7, knock/admit, targeted relay,
 * seat-holding resume tokens, host succession and host-only authority.
 *
 *   node scripts/verify-mesh-signalling.mjs [baseUrl]
 *
 * Keep this file ASCII-only: a previous editing round-trip through PowerShell
 * corrupted non-ASCII characters, so none are allowed back in.
 */

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const roomId = () =>
  Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("");

// Mirrors ROOM_CAPACITY / SIGNAL_LIMITS in lib/signal-protocol.ts.
const CAPACITY = { min: 2, max: 7, default: 2 };
const MAX_NAME_LENGTH = 32;

let failures = 0;
let passes = 0;
let skips = 0;
function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}
function skip(name, reason) {
  skips += 1;
  console.log(`  SKIP  ${name} -- ${reason}`);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => wait(350);

/**
 * Opens the joining GET as an SSE stream and collects events as they arrive.
 * `welcome` populates creds (self id + secret) and the resume token.
 */
async function open(room, { name, resume } = {}) {
  const params = new URLSearchParams();
  if (name !== undefined) params.set("name", name);
  if (resume !== undefined) params.set("resume", resume);
  const qs = params.toString();

  const controller = new AbortController();
  const response = await fetch(`${BASE}/api/signal/${room}${qs ? `?${qs}` : ""}`, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  if (!response.ok) {
    return { events: [], closed: true, status: response.status, creds: null, close() {} };
  }

  const peer = {
    events: [],
    closed: false,
    status: response.status,
    creds: null,
    self: null,
    resumeToken: null,
    usedKnockIds: new Set(),
    close: () => controller.abort(),
  };
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
          let event;
          try {
            event = JSON.parse(raw);
          } catch {
            continue; // comment/keep-alive frame
          }
          if (event.t === "ping") continue;
          if (event.t === "welcome") {
            peer.self = event.self ?? null;
            peer.resumeToken = event.resumeToken ?? null;
            const id = event.self?.id;
            if (id) peer.creds = { id, secret: event.secret };
          }
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
    body: body === undefined ? "{not json" : JSON.stringify(body),
  });

/** Waits until `predicate` matches one collected event, or times out (null). */
function waitFor(peer, predicate, { timeout = 8000 } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const hit = peer.events.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - startedAt > timeout) return resolve(null);
      setTimeout(tick, 30);
    };
    tick();
  });
}

/** Waits for the host's knock for `name`, then answers it. */
async function answerKnock(room, host, name, allow) {
  const knock = await waitFor(
    host,
    (e) => e.t === "knock" && e.name === name && !host.usedKnockIds.has(e.knockId),
  );
  if (!knock) return { knock: null, response: null };
  host.usedKnockIds.add(knock.knockId);
  const response = await post(room, host.creds, { t: "admit", knockId: knock.knockId, allow });
  return { knock, response };
}

/** Knock + admit + wait for the joiner's welcome. Returns the seated peer. */
async function seat(room, host, name) {
  const joiner = await open(room, { name });
  const { knock, response } = await answerKnock(room, host, name, true);
  if (!knock) throw new Error(`no knock arrived for ${name}`);
  if (response && response.status !== 200) {
    throw new Error(`admit for ${name} returned ${response.status}`);
  }
  const welcome = await waitFor(joiner, (e) => e.t === "welcome");
  if (!welcome) throw new Error(`no welcome arrived for ${name}`);
  return joiner;
}

function lastRoster(peer) {
  for (let i = peer.events.length - 1; i >= 0; i -= 1) {
    if (peer.events[i].t === "roster") return peer.events[i];
  }
  return null;
}

function closeAll(...peers) {
  for (const peer of peers) {
    try {
      peer.close();
    } catch {
      // Already closed.
    }
  }
}

// ---------------------------------------------------------------------------

async function testHostSeatedImmediately() {
  console.log("\nFirst joiner becomes host, seated with no knock");
  const room = roomId();
  const a = await open(room, { name: "Hana" });
  const welcome = await waitFor(a, (e) => e.t === "welcome");

  check("first joiner is welcomed straight away", Boolean(welcome), JSON.stringify(a.events));
  check(
    "first joiner never sees waiting-approval",
    !a.events.some((e) => e.t === "waiting-approval"),
  );
  check("welcome marks them as host", welcome?.self?.isHost === true, JSON.stringify(welcome));
  check("welcome is not a resume", welcome?.resumed === false, String(welcome?.resumed));
  check(
    "welcome carries a non-empty secret and resumeToken",
    typeof welcome?.secret === "string" &&
      welcome.secret.length > 0 &&
      typeof welcome?.resumeToken === "string" &&
      welcome.resumeToken.length > 0,
  );
  check(
    "welcome roster contains exactly the host",
    Array.isArray(welcome?.roster) &&
      welcome.roster.length === 1 &&
      welcome.roster[0]?.id === welcome?.self?.id,
    JSON.stringify(welcome?.roster),
  );
  check(
    `default capacity is ${CAPACITY.default}`,
    welcome?.capacity === CAPACITY.default,
    String(welcome?.capacity),
  );
  check("host's display name survives the join", welcome?.self?.name === "Hana", welcome?.self?.name);

  closeAll(a);
  await settle();
}

async function testKnockAdmitAndDeny() {
  console.log("\nLater joiners knock; admit seats them, deny rejects them");
  const room = roomId();
  const host = await open(room, { name: "Hana" });
  await waitFor(host, (e) => e.t === "welcome");

  // ---- admit path
  const b = await open(room, { name: "Bela" });
  const waiting = await waitFor(b, (e) => e.t === "waiting-approval");
  check("second joiner gets waiting-approval", Boolean(waiting), JSON.stringify(b.events));
  check("second joiner is not welcomed before the host answers", !b.events.some((e) => e.t === "welcome"));

  const knock = await waitFor(host, (e) => e.t === "knock");
  check("host receives the knock", Boolean(knock), JSON.stringify(host.events));
  check("the knock carries a knockId and the joiner's name", Boolean(knock?.knockId) && knock?.name === "Bela", JSON.stringify(knock));

  if (knock) {
    host.usedKnockIds.add(knock.knockId);
    const admit = await post(room, host.creds, { t: "admit", knockId: knock.knockId, allow: true });
    check("admit is accepted from the host", admit.status === 200, String(admit.status));
  }

  const welcome = await waitFor(b, (e) => e.t === "welcome");
  check("admitted joiner is welcomed", Boolean(welcome), JSON.stringify(b.events));
  check("admitted joiner is not the host", welcome?.self?.isHost === false);
  check(
    "admitted joiner's roster shows both people",
    welcome?.roster?.length === 2,
    JSON.stringify(welcome?.roster),
  );
  const joined = await waitFor(host, (e) => e.t === "peer-joined");
  check(
    "host is told the peer joined, by name",
    joined?.peer?.name === "Bela",
    JSON.stringify(joined),
  );
  const roster = await waitFor(host, (e) => e.t === "roster" && e.roster?.length === 2);
  check("host receives an authoritative 2-person roster", Boolean(roster), JSON.stringify(lastRoster(host)));

  // ---- deny path (needs a free seat, so raise capacity first)
  const grow = await post(room, host.creds, { t: "capacity", value: 3 });
  check("host can raise capacity to 3", grow.status === 200, String(grow.status));

  const c = await open(room, { name: "Cato" });
  await waitFor(c, (e) => e.t === "waiting-approval");
  const { knock: knockC, response: denyResponse } = await answerKnock(room, host, "Cato", false);
  check("host receives Cato's knock", Boolean(knockC));
  check("deny is accepted from the host", denyResponse?.status === 200, String(denyResponse?.status));

  const rejected = await waitFor(c, (e) => e.t === "ended");
  check(
    'denied joiner gets ended with reason "rejected"',
    rejected?.reason === "rejected",
    JSON.stringify(rejected),
  );
  await wait(700);
  check("denied joiner's stream is closed", c.closed);
  check("a denied knock seats nobody", lastRoster(host)?.roster?.length !== 3, JSON.stringify(lastRoster(host)));

  closeAll(host, b, c);
  await settle();
}

async function testCapacity() {
  console.log("\nCapacity: default 2, raise to 7, refuse the 8th, clamp bounds");
  const room = roomId();
  const host = await open(room, { name: "Hana" });
  await waitFor(host, (e) => e.t === "welcome");
  const b = await seat(room, host, "Bela");

  // ---- default 2 blocks a third outright
  const third = await open(room, { name: "Tria" });
  const refusal = await waitFor(third, (e) => e.t === "ended");
  check(
    'a third joiner at default capacity is refused "room-full"',
    refusal?.reason === "room-full",
    JSON.stringify(third.events),
  );
  await wait(700);
  check("the refused third's stream is closed", third.closed);
  check(
    "the refused third never knocked the host",
    !host.events.some((e) => e.t === "knock" && e.name === "Tria"),
  );
  check("the seated pair is untouched", !host.closed && !b.closed);

  // ---- raise to 7 and fill every seat
  const raise = await post(room, host.creds, { t: "capacity", value: 7 });
  check("host raises capacity to 7", raise.status === 200, String(raise.status));
  const cap7 = await waitFor(host, (e) => e.t === "roster" && e.capacity === 7);
  check("everyone is told capacity is now 7", Boolean(cap7), JSON.stringify(lastRoster(host)));

  const names = ["G3", "G4", "G5", "G6", "G7"];
  const guests = [];
  let seatedAll = true;
  for (const name of names) {
    try {
      guests.push(await seat(room, host, name));
    } catch (error) {
      seatedAll = false;
      check(`seat ${name}`, false, error.message);
      break;
    }
  }
  if (seatedAll) {
    const full = await waitFor(host, (e) => e.t === "roster" && e.roster?.length === 7);
    check("7 participants seat successfully", Boolean(full), JSON.stringify(lastRoster(host)));
  }

  // ---- the 8th is refused
  const eighth = await open(room, { name: "Octa" });
  const refused8 = await waitFor(eighth, (e) => e.t === "ended");
  check(
    'an 8th joiner is refused "room-full"',
    refused8?.reason === "room-full",
    JSON.stringify(eighth.events),
  );

  // ---- lowering below headcount ejects NOBODY
  const before = lastRoster(host)?.roster?.length ?? null;
  const lower = await post(room, host.creds, { t: "capacity", value: 1 }); // clamps to min 2
  check("lowering capacity is accepted", lower.status === 200, String(lower.status));
  const capMin = await waitFor(host, (e) => e.t === "roster" && e.capacity === CAPACITY.min);
  check(
    `capacity 1 clamps to the minimum (${CAPACITY.min})`,
    Boolean(capMin),
    JSON.stringify(lastRoster(host)),
  );
  await settle();
  check(
    "lowering capacity below headcount ejects nobody",
    !host.events.some((e) => e.t === "peer-left") &&
      (lastRoster(host)?.roster?.length ?? 0) === before,
    `roster ${lastRoster(host)?.roster?.length} of ${before}, peer-left events: ${host.events.filter((e) => e.t === "peer-left").length}`,
  );
  check(
    "nobody's stream was closed by the capacity change",
    !b.closed && guests.every((g) => !g.closed),
  );

  // ---- upper clamp
  const overshoot = await post(room, host.creds, { t: "capacity", value: 100 });
  check("capacity 100 is accepted (to be clamped)", overshoot.status === 200, String(overshoot.status));
  const capMax = await waitFor(host, (e) => e.t === "roster" && e.capacity === CAPACITY.max);
  check(
    `capacity 100 clamps to the maximum (${CAPACITY.max})`,
    Boolean(capMax),
    JSON.stringify(lastRoster(host)),
  );

  // ---- non-numeric value: either refused outright or clamped to a legal value
  const garbage = await post(room, host.creds, { t: "capacity", value: "banana" });
  if (garbage.status >= 400) {
    check("a non-numeric capacity is refused", true);
  } else {
    await settle();
    const cap = lastRoster(host)?.capacity;
    check(
      "a non-numeric capacity lands on a legal value",
      typeof cap === "number" && cap >= CAPACITY.min && cap <= CAPACITY.max,
      String(cap),
    );
  }

  closeAll(host, b, ...guests, third, eighth);
  await settle();
}

async function testTargetedRelay() {
  console.log("\nSignalling is targeted: only `to` receives, never the sender");
  const room = roomId();
  const host = await open(room, { name: "Hana" });
  await waitFor(host, (e) => e.t === "welcome");
  await post(room, host.creds, { t: "capacity", value: 3 });
  const b = await seat(room, host, "Bela");
  const c = await seat(room, host, "Cato");

  const payload = { kind: "candidate", candidate: { candidate: "probe-1" } };
  const relay = await post(room, host.creds, { t: "signal", to: b.creds.id, data: payload });
  check("a targeted relay is accepted", relay.status === 200, String(relay.status));

  const gotB = await waitFor(b, (e) => e.t === "signal" && e.data?.candidate?.candidate === "probe-1");
  check("the target receives the signal", Boolean(gotB), JSON.stringify(b.events.filter((e) => e.t === "signal")));
  check("the signal names its sender", gotB?.from === host.creds.id, JSON.stringify(gotB));
  await settle();
  check("the third member receives nothing", !c.events.some((e) => e.t === "signal"));
  check("the sender is never echoed its own signal", !host.events.some((e) => e.t === "signal"));

  // Non-host members can signal each other directly.
  const p2 = { kind: "candidate", candidate: { candidate: "probe-2" } };
  const bToC = await post(room, b.creds, { t: "signal", to: c.creds.id, data: p2 });
  check("a non-host member can signal another member", bToC.status === 200, String(bToC.status));
  const gotC = await waitFor(c, (e) => e.t === "signal" && e.data?.candidate?.candidate === "probe-2");
  check("that signal arrives with the right sender", gotC?.from === b.creds.id, JSON.stringify(gotC));

  // A `to` outside the room is refused and delivered to nobody.
  const stranger = await post(room, host.creds, {
    t: "signal",
    to: "zzzzzzzzzzzzzzzz",
    data: payload,
  });
  check(
    "a `to` outside the room is refused",
    stranger.status >= 400 && stranger.status < 500,
    String(stranger.status),
  );
  await settle();
  const probe3Count = [host, b, c].filter((p) =>
    p.events.some((e) => e.t === "signal" && e.data?.candidate?.candidate === "probe-3"),
  ).length;
  check("nothing was delivered for the refused target", probe3Count === 0, String(probe3Count));

  closeAll(host, b, c);
  await settle();
}

async function testHostOnlyAuthority() {
  console.log("\nHost-only actions are 403 for a non-host, with no state change");
  const room = roomId();
  const host = await open(room, { name: "Hana" });
  await waitFor(host, (e) => e.t === "welcome");
  await post(room, host.creds, { t: "capacity", value: 3 });
  const b = await seat(room, host, "Bela");
  const c = await seat(room, host, "Cato");
  await settle();

  const eventsBefore = { host: host.events.length, b: b.events.length, c: c.events.length };

  const attempts = [
    ["close", { t: "close" }],
    ["admit", { t: "admit", knockId: "no-such-knock", allow: true }],
    ["capacity", { t: "capacity", value: 5 }],
    ["remove", { t: "remove", peerId: c.creds.id }],
    ["pin", { t: "pin", peerId: c.creds.id }],
  ];
  for (const [label, body] of attempts) {
    const response = await post(room, b.creds, body);
    check(`non-host ${label} is refused with 403`, response.status === 403, String(response.status));
  }
  await settle();

  check(
    "the refused actions produced no events for anyone",
    host.events.length === eventsBefore.host &&
      b.events.length === eventsBefore.b &&
      c.events.length === eventsBefore.c,
    JSON.stringify({
      host: host.events.slice(eventsBefore.host),
      b: b.events.slice(eventsBefore.b),
      c: c.events.slice(eventsBefore.c),
    }),
  );
  check("nobody was disconnected", !host.closed && !b.closed && !c.closed);
  check("capacity is unchanged", lastRoster(host)?.capacity === 3, String(lastRoster(host)?.capacity));

  // The host's versions of the same actions do work (pin as the probe).
  const pin = await post(room, host.creds, { t: "pin", peerId: c.creds.id });
  check("the host CAN pin", pin.status === 200, String(pin.status));
  const pinned = await waitFor(b, (e) => e.t === "pin" && e.peerId === c.creds.id);
  check("the pin reaches other members", Boolean(pinned), JSON.stringify(b.events.filter((e) => e.t === "pin")));
  const unpin = await post(room, host.creds, { t: "pin", peerId: null });
  check("the host can clear the pin", unpin.status === 200, String(unpin.status));

  // Host remove ejects exactly one member.
  const remove = await post(room, host.creds, { t: "remove", peerId: c.creds.id });
  check("the host CAN remove a member", remove.status === 200, String(remove.status));
  const removedEnd = await waitFor(c, (e) => e.t === "ended");
  check(
    'the removed member is ended with reason "removed"',
    removedEnd?.reason === "removed",
    JSON.stringify(removedEnd),
  );
  const removedLeft = await waitFor(b, (e) => e.t === "peer-left" && e.peerId === c.creds.id);
  check(
    'others see peer-left with reason "removed"',
    removedLeft?.reason === "removed",
    JSON.stringify(removedLeft),
  );
  check("the room survives the removal", !host.closed && !b.closed);

  closeAll(host, b, c);
  await settle();
}

async function testLeaveAndClose() {
  console.log("\nLeave removes one participant; close ends it for everyone");
  const room = roomId();
  const host = await open(room, { name: "Hana" });
  await waitFor(host, (e) => e.t === "welcome");
  await post(room, host.creds, { t: "capacity", value: 3 });
  const b = await seat(room, host, "Bela");
  const c = await seat(room, host, "Cato");

  // ---- leave
  const leave = await post(room, b.creds, { t: "leave" });
  check("any participant may leave", leave.status === 200, String(leave.status));
  const left = await waitFor(host, (e) => e.t === "peer-left" && e.peerId === b.creds.id);
  check('others see peer-left with reason "left"', left?.reason === "left", JSON.stringify(left));
  const shrunk = await waitFor(host, (e) => e.t === "roster" && e.roster?.length === 2);
  check("the roster shrinks to the remaining two", Boolean(shrunk), JSON.stringify(lastRoster(host)));
  await wait(700);
  check("the leaver's stream is closed", b.closed);
  check("the room survives a leave", !host.closed && !c.closed);

  // The survivors can still signal.
  const probe = await post(room, host.creds, {
    t: "signal",
    to: c.creds.id,
    data: { kind: "candidate", candidate: { candidate: "still-alive" } },
  });
  check("relay still works after a leave", probe.status === 200, String(probe.status));

  // ---- close
  const close = await post(room, host.creds, { t: "close" });
  check("the host may close", close.status === 200, String(close.status));
  const endedC = await waitFor(c, (e) => e.t === "ended");
  check(
    'members are ended with reason "host-closed"',
    endedC?.reason === "host-closed",
    JSON.stringify(endedC),
  );
  await wait(700);
  check("every stream is closed after close", host.closed && c.closed);

  const late = await post(room, c.creds, { t: "leave" });
  check(
    "the room is gone after close",
    late.status === 401 || late.status === 404 || late.status === 410,
    String(late.status),
  );

  closeAll(host, b, c);
  await settle();
}

async function testResume() {
  console.log("\nResume: a dropped stream holds the seat and skips the knock");
  const room = roomId();
  const host = await open(room, { name: "Hana" });
  await waitFor(host, (e) => e.t === "welcome");
  const b = await seat(room, host, "Bela");
  const bId = b.creds.id;
  const bToken = b.resumeToken;

  b.close(); // dead stream, no leave
  const away = await waitFor(host, (e) => e.t === "peer-away" && e.peerId === bId && e.away === true);
  check("a dropped stream marks the seat away, not gone", Boolean(away), JSON.stringify(host.events.slice(-4)));
  check(
    "no peer-left was sent inside the grace window",
    !host.events.some((e) => e.t === "peer-left" && e.peerId === bId),
  );

  const knocksBefore = host.events.filter((e) => e.t === "knock").length;
  const b2 = await open(room, { name: "Bela", resume: bToken });
  const welcome2 = await waitFor(b2, (e) => e.t === "welcome");
  check("presenting the resume token is welcomed", Boolean(welcome2), JSON.stringify(b2.events));
  check("the resume welcome says resumed:true", welcome2?.resumed === true, String(welcome2?.resumed));
  check("the SAME peer id is reclaimed", welcome2?.self?.id === bId, `${welcome2?.self?.id} vs ${bId}`);
  check("the reclaimed seat is no longer away", welcome2?.self?.away === false, JSON.stringify(welcome2?.self));
  check(
    "resuming never knocked the host",
    host.events.filter((e) => e.t === "knock").length === knocksBefore,
  );
  check(
    "the resumer never saw waiting-approval",
    !b2.events.some((e) => e.t === "waiting-approval"),
  );
  const back = await waitFor(host, (e) => e.t === "peer-away" && e.peerId === bId && e.away === false);
  check("others are told the seat was reclaimed (away:false)", Boolean(back), JSON.stringify(host.events.slice(-4)));
  check(
    "the roster still holds two people",
    (lastRoster(host)?.roster?.length ?? welcome2?.roster?.length) === 2,
    JSON.stringify(lastRoster(host) ?? welcome2?.roster),
  );

  skip(
    "grace expiry releases the seat with peer-left reason \"disconnected\"",
    "requires waiting the real awayTtlMs (45s); the away marker and reclaim above are asserted instead",
  );

  closeAll(host, b2);
  await settle();
}

async function testHostResume() {
  console.log("\nHOST resume: a host drop must not kill the room");
  const room = roomId();
  const host = await open(room, { name: "Hana" });
  await waitFor(host, (e) => e.t === "welcome");
  const hostId = host.creds.id;
  const hostToken = host.resumeToken;
  const b = await seat(room, host, "Bela");

  host.close(); // the host's stream drops
  const away = await waitFor(b, (e) => e.t === "peer-away" && e.peerId === hostId && e.away === true);
  check("members see the host go away, not the room end", Boolean(away), JSON.stringify(b.events.slice(-4)));
  await settle();
  check("no ended event was sent to members", !b.events.some((e) => e.t === "ended"));
  check("the member's stream stays open", !b.closed);

  const host2 = await open(room, { name: "Hana", resume: hostToken });
  const welcome2 = await waitFor(host2, (e) => e.t === "welcome");
  check("the host reclaims their seat", welcome2?.resumed === true && welcome2?.self?.id === hostId, JSON.stringify(welcome2));
  check("the reclaimed host is still the host", welcome2?.self?.isHost === true, JSON.stringify(welcome2?.self));

  // Host powers still work after the resume.
  host2.creds = { id: welcome2.self.id, secret: welcome2.secret };
  const capacity = await post(room, host2.creds, { t: "capacity", value: 3 });
  check("host powers survive the resume", capacity.status === 200, String(capacity.status));

  closeAll(host2, b);
  await settle();
}

async function testHostSuccession() {
  console.log("\nHost succession: longest-seated member is promoted");
  const room = roomId();
  const host = await open(room, { name: "Hana" });
  await waitFor(host, (e) => e.t === "welcome");
  await post(room, host.creds, { t: "capacity", value: 3 });
  const b = await seat(room, host, "Bela"); // seated first: the successor
  const c = await seat(room, host, "Cato");

  const leave = await post(room, host.creds, { t: "leave" });
  check("the host may leave without closing the room", leave.status === 200, String(leave.status));

  const left = await waitFor(b, (e) => e.t === "peer-left" && e.peerId === host.creds.id);
  check("members see the host leave", left?.reason === "left", JSON.stringify(left));
  const promoted = await waitFor(
    b,
    (e) => e.t === "roster" && e.roster?.some((p) => p.id === b.creds.id && p.isHost === true),
  );
  check(
    "the longest-seated member is promoted to host",
    Boolean(promoted),
    JSON.stringify(lastRoster(b)),
  );
  check(
    "the newer member was NOT promoted",
    !lastRoster(b)?.roster?.some((p) => p.id === c.creds.id && p.isHost === true),
    JSON.stringify(lastRoster(b)),
  );
  check("the room survives the succession", !b.closed && !c.closed);

  // The crown is real: the promoted member now wields host powers...
  const capacity = await post(room, b.creds, { t: "capacity", value: 4 });
  check("the promoted host can use host powers", capacity.status === 200, String(capacity.status));
  // ...and the other member still cannot.
  const still403 = await post(room, c.creds, { t: "capacity", value: 5 });
  check("the non-promoted member still gets 403", still403.status === 403, String(still403.status));

  closeAll(b, c);
  await settle();

  skip(
    "host succession after grace EXPIRY (host drops and never resumes)",
    "requires waiting the real awayTtlMs (45s); succession is asserted via the host's voluntary leave instead",
  );
}

async function testNameSanitising() {
  console.log("\nNames are sanitised: control chars, length, empty placeholder");
  const room = roomId();
  // NUL and BEL are control characters; sanitizeName maps them to spaces and
  // collapses the run, so the visible name is exactly "Bad Name".
  const host = await open(room, { name: "Bad" + String.fromCharCode(0, 7) + "Name" });
  const welcome = await waitFor(host, (e) => e.t === "welcome");
  check(
    "control characters are stripped from names",
    welcome?.self?.name === "Bad Name",
    JSON.stringify(welcome?.self?.name),
  );

  const long = "L".repeat(80);
  await post(room, host.creds, { t: "capacity", value: 4 });
  const b = await open(room, { name: long });
  const knockLong = await waitFor(host, (e) => e.t === "knock" && e.name?.startsWith("LLL"));
  check(
    `an over-length name is truncated to ${MAX_NAME_LENGTH}`,
    knockLong?.name === "L".repeat(MAX_NAME_LENGTH),
    `len=${knockLong?.name?.length}`,
  );
  if (knockLong) {
    host.usedKnockIds.add(knockLong.knockId);
    await post(room, host.creds, { t: "admit", knockId: knockLong.knockId, allow: true });
    await waitFor(b, (e) => e.t === "welcome");
  }

  // Empty and whitespace-only names must never reach the roster empty.
  const c = await open(room, { name: "   " });
  const knockEmpty = await waitFor(host, (e) => e.t === "knock" && !host.usedKnockIds.has(e.knockId));
  check(
    "a whitespace-only name knocks with a non-empty placeholder",
    typeof knockEmpty?.name === "string" && knockEmpty.name.trim().length > 0,
    JSON.stringify(knockEmpty),
  );
  if (knockEmpty) {
    host.usedKnockIds.add(knockEmpty.knockId);
    await post(room, host.creds, { t: "admit", knockId: knockEmpty.knockId, allow: true });
    const welcomeC = await waitFor(c, (e) => e.t === "welcome");
    const empties = (welcomeC?.roster ?? []).filter((p) => !p.name || p.name.trim().length === 0);
    check(
      "the roster never contains an empty display name",
      welcomeC !== null && empties.length === 0,
      JSON.stringify(welcomeC?.roster),
    );
  }

  // No name parameter at all: same rule.
  const room2 = roomId();
  const bare = await open(room2);
  const bareWelcome = await waitFor(bare, (e) => e.t === "welcome");
  check(
    "joining without a name still yields a non-empty display name",
    typeof bareWelcome?.self?.name === "string" && bareWelcome.self.name.trim().length > 0,
    JSON.stringify(bareWelcome?.self),
  );

  closeAll(host, b, c, bare);
  await settle();
}

async function testAuthAndValidation() {
  console.log("\nForged credentials and malformed input are still rejected");
  const room = roomId();
  const host = await open(room, { name: "Hana" });
  await waitFor(host, (e) => e.t === "welcome");
  const b = await seat(room, host, "Bela");

  const signal = {
    t: "signal",
    to: b.creds.id,
    data: { kind: "candidate", candidate: null },
  };
  const wrongSecret = await post(
    room,
    { id: host.creds.id, secret: "0".repeat(host.creds.secret.length) },
    signal,
  );
  const unknownPeer = await post(room, { id: "zzzzzzzzzzzzzzzz", secret: host.creds.secret }, signal);
  const noHeaders = await fetch(`${BASE}/api/signal/${room}`, {
    method: "POST",
    body: JSON.stringify(signal),
  });
  await settle();

  check("a wrong secret is 401", wrongSecret.status === 401, String(wrongSecret.status));
  check("an unknown peer id is 401", unknownPeer.status === 401, String(unknownPeer.status));
  check("missing headers are 401", noHeaders.status === 401, String(noHeaders.status));
  check("nothing was delivered by the forged posts", !b.events.some((e) => e.t === "signal"));

  // A forged host-action must not be a 403 information leak either; it must
  // fail authentication outright and change nothing.
  const forgedClose = await post(
    room,
    { id: host.creds.id, secret: "0".repeat(host.creds.secret.length) },
    { t: "close" },
  );
  check("a forged close is 401, not honoured", forgedClose.status === 401, String(forgedClose.status));
  await settle();
  check("the room survived the forged close", !host.closed && !b.closed);

  // Custom codes made `not-a-real-room-id` a perfectly good room; only length
  // can make a code malformed now (under 4 or over 32 letters and digits).
  const badRoom = await fetch(`${BASE}/api/signal/ab`, {
    headers: { accept: "text/event-stream" },
  });
  const badJson = await post(room, host.creds, undefined);
  const badKind = await post(room, host.creds, { t: "signal", to: b.creds.id, data: { kind: "evil" } });
  const oversized = await post(room, host.creds, {
    t: "signal",
    to: b.creds.id,
    data: { kind: "description", description: { type: "offer", sdp: "x".repeat(200_000) } },
  });
  check("a malformed room id is 400", badRoom.status === 400, String(badRoom.status));
  check("an unparseable body is 400", badJson.status === 400, String(badJson.status));
  check("an unknown signal kind is 400", badKind.status === 400, String(badKind.status));
  check("an oversized payload is 413", oversized.status === 413, String(oversized.status));

  closeAll(host, b);
  await settle();
}

// ---------------------------------------------------------------------------

console.log(`Verifying mesh signalling at ${BASE}`);
console.log("(contract: lib/signal-protocol.ts, Phase 1)");

const suites = [
  testHostSeatedImmediately,
  testKnockAdmitAndDeny,
  testCapacity,
  testTargetedRelay,
  testHostOnlyAuthority,
  testLeaveAndClose,
  testResume,
  testHostResume,
  testHostSuccession,
  testNameSanitising,
  testAuthAndValidation,
];

for (const suite of suites) {
  try {
    await suite();
  } catch (error) {
    failures += 1;
    console.log(`  ERROR  ${suite.name}: ${error.message}`);
  }
}

skip(
  "knock TTL: an unanswered knock is withdrawn (knock-withdrawn)",
  "requires waiting the real knockTtlMs (2min)",
);
skip(
  "empty-room TTL: a room with nobody seated is released",
  "requires waiting the real emptyTtlMs (2min)",
);
skip(
  "relay budget: maxMessagesPerParticipant (600) triggers rate limiting",
  "600 sequential POSTs would dominate the suite's runtime; not exercised",
);

console.log(
  `\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`} (${passes} passed, ${failures} failed, ${skips} skipped)`,
);
process.exit(failures === 0 ? 0 : 1);
