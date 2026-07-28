# Architecture

This document is for someone modifying the code. It describes the system as
implemented — file references point at the single source of truth for each
part. For a high-level overview, start with the [README](../README.md).

Contents:

- [Signalling wire protocol](#signalling-wire-protocol)
- [Server room lifecycle](#server-room-lifecycle)
- [Client session state machine](#client-session-state-machine)
- [Data-channel protocols](#data-channel-protocols)
- [How React binds to the session](#how-react-binds-to-the-session)
- [Extending it](#extending-it)

## Signalling wire protocol

Types: `lib/signal-protocol.ts`. Server: `app/api/signal/[roomId]/route.ts`
plus `lib/server/rooms.ts`. Client: `lib/signal-client.ts`.

The entire backend is one route, `/api/signal/[roomId]`:

- **`GET` — the GET itself is the join.** There is no separate join call: a
  successful `GET` enters the room and returns a `text/event-stream` (SSE)
  response that stays open for the life of the session. The stream aborting
  (tab closed, network gone) *is* the leave signal — the route's
  `request.signal` abort handler and the stream's `cancel()` both call
  `leaveRoom`, which destroys the room.
- **`POST` — one message per request**, authenticated with two headers issued
  in the `welcome` event: `x-peer-id` and `x-peer-secret`. The client never
  stores these anywhere except the in-memory `SignalClient`.

The client deliberately uses `fetch` with a manual SSE parser instead of
`EventSource`: it needs the HTTP status code on failure, and it must *not*
get `EventSource`'s automatic reconnect — a dropped stream means the session
is over, and silently rejoining would re-open a room that was just torn down.

### Server -> client events (SSE `data:` frames, JSON)

| Event | Payload | Meaning |
| --- | --- | --- |
| `welcome` | `peerId`, `secret`, `role` (`initiator` \| `responder`), `peerPresent`, `isHost`, `guestMayEnd` | You are in. First occupant is `initiator` and host; second is `responder`. |
| `peer-joined` | — | The second occupant arrived; the room is now sealed. Sent only to the first occupant. |
| `peer-left` | `reason: EndReason` | Terminal. Also used to refuse entry: a rejected `GET` still returns 200 and delivers `peer-left` with reason `room-full` or `session-over` before closing the stream. |
| `signal` | `data: SignalPayload` | A relayed WebRTC description or ICE candidate from the other peer. |
| `permission` | `guestMayEnd: boolean` | The host toggled whether the guest may end the session. Sent to the guest. |
| `ping` | — | Keep-alive every 20 s so proxies do not drop the idle stream. Ignored by the client. |

`EndReason` values (`lib/signal-protocol.ts`): `peer-left`, `peer-ended`,
`room-full`, `session-over`, `room-closed`, `expired`, `transport-error`,
`self-ended`.

### Client -> server messages (POST bodies, JSON)

| Message | Payload | Meaning |
| --- | --- | --- |
| `signal` | `data: SignalPayload` | Relay one SDP description or ICE candidate to the other peer, verbatim. |
| `bye` | — | Deliberate hang-up. Authorised: the host always may; the guest only if `guestMayEnd` is set. |
| `permission` | `allow: boolean` | Host only: grant or revoke the guest's right to end the session. |

`SignalPayload` is either `{ kind: "description", description }` or
`{ kind: "candidate", candidate }` (candidate may be `null` —
end-of-candidates).

### HTTP status codes

`GET`:

| Status | When |
| --- | --- |
| 400 | Room id fails `isValidRoomId` (not 16 chars of the Crockford-style alphabet). |
| 200 | Everything else — including refusals, which arrive in-stream as `peer-left`. |

`POST`:

| Status | When |
| --- | --- |
| 400 | Invalid room id, unparsable JSON, unknown message type, malformed `signal` payload, or `permission` without a boolean `allow`. |
| 401 | Missing `x-peer-id`/`x-peer-secret` headers, or credentials that do not match an occupant. |
| 403 | `bye` from a guest who has not been granted `guestMayEnd`, or `permission` from a non-host. The room is untouched. |
| 410 | The room no longer exists (`unknown-room`). |
| 413 | Body exceeds `SIGNAL_LIMITS.maxMessageBytes` (96 KiB). |
| 429 | The room exceeded its relay budget (`maxMessagesPerRoom`, 400) — the room is destroyed. |
| 200 | Accepted. Relays additionally report `delivered: false` when no other peer is present yet. |

## Server room lifecycle

File: `lib/server/rooms.ts`. Everything lives in two module-level maps hung
off `globalThis` (so Next's dev-mode module reloads do not orphan live
rooms): `registry` (id -> Room) and `spent` (id -> tombstone expiry).

```text
            GET (first peer)
   (none) ────────────────────> lobby        occupants: 1, sealed: false
                                  │  lobbyTtl (10 min) or last occupant leaves
                                  │──────────────> destroyed, NOT tombstoned
                                  │
                                  │  GET (second peer)
                                  v
                                sealed       occupants: 2, sealed: true
                                  │  either peer leaves / bye / relay budget /
                                  │  hard TTL (60 min)
                                  v
                             destroyed + tombstoned (spent, 15 min)
```

Key rules, each tied to an invariant:

- **Sealing.** The moment the second occupant joins, `sealed` is set and the
  lobby timer is cleared. A sealed room rejects *every* further join —
  including a peer trying to reclaim a slot it just vacated. A vacated slot
  is never refilled; reconnecting means a brand-new room.
- **Symmetric teardown.** `destroyRoom` deletes the registry entry first (so
  re-entrant calls from occupants' `disconnect` handlers are no-ops), then
  emits `peer-left` to everyone except the peer that caused the teardown,
  then closes both streams.
- **Tombstones.** `destroyRoom` writes the room id into `spent` **only if
  the room had sealed**. A later join of a spent id is refused with
  `session-over`. A lobby-only room (one occupant, nobody ever joined) is
  deliberately *not* tombstoned: refreshing the page while waiting alone
  re-runs the GET, and the code must still work. The `spent` map is swept on
  every join (`sweepSpent`), which keeps it bounded without a timer.
- **Host authority.** `hostPeerId` is the first occupant's peer id. Because a
  room whose sole occupant leaves is always destroyed, `hostPeerId` can never
  point at a departed peer. `endSession` (the `bye` handler) requires host or
  `guestMayEnd`; `setGuestMayEnd` requires host and pushes a `permission`
  event to the guest so its UI updates live.

Every limit in `SIGNAL_LIMITS` (`lib/signal-protocol.ts`) and its purpose:

| Limit | Value | Purpose |
| --- | --- | --- |
| `maxMessageBytes` | 96 KiB | Caps a POST body. SDP for audio+video+2 data channels stays well under this; anything bigger is not signalling. |
| `maxMessagesPerRoom` | 400 | Per-room relay budget. Renegotiation and ICE never come close; exceeding it means abuse, and the room is destroyed. |
| `lobbyTtlMs` | 10 min | Garbage-collects a room nobody ever joined (`expired`). |
| `spentTtlMs` | 15 min | How long a finished session's code stays tombstoned. Long enough to cover a reload storm; the 80-bit id space makes later reuse a non-issue. |
| `roomTtlMs` | 60 min | Hard ceiling on any room's lifetime in the registry (`room-closed`). Signalling is only needed for setup and renegotiation, so an hour is generous. |
| `keepAliveMs` | 20 s | SSE `ping` interval so proxies do not drop idle streams. |

Peer credentials are generated server-side per connection (`createToken` in
`lib/ids.ts`: peer id 16 chars, secret 48 chars from a CSPRNG) and never
reused across sessions.

## Client session state machine

File: `lib/peer-session.ts` (`PeerSession`). One instance per room page
mount, created by `hooks/use-peer-session.ts`.

```text
idle ──start()──> joining ──welcome(peerPresent=false)──> waiting
                     │                                       │
                     │ welcome(peerPresent=true)             │ peer-joined
                     v                                       v
                 connecting <────────────────────────── connecting
                     │ both data channels open
                     v
                 connected ──(any terminal event)──> ended
```

Transitions are driven by:

- `start()`: opens the `SignalClient` stream (`joining`).
- `welcome`: creates the `RTCPeerConnection`; `waiting` if alone,
  `connecting` if the peer is already there (we are the second joiner).
- `peer-joined`: the initiator creates both data channels, which fires
  `negotiationneeded` and kicks off the offer/answer exchange.
- channel `open`: once *both* channels are open, phase becomes `connected`.
- Anything terminal — `peer-left`, channel `close`, ICE failure, transport
  error, local `end()` — lands in `ended`.

**`end()` is a one-way trapdoor.** It sets `phase = "ended"` directly and
`setPhase` refuses any transition out of `ended`. This matters because the
teardown races a swarm of late async callbacks (ICE state changes, channel
events, a `getUserMedia` promise resolving after the fact) — none of them may
resurrect a dead session. `end()` also tears down *everything*: signalling
stream (sending `bye` first for a deliberate hang-up, so the peer learns it
was intentional rather than a disconnect), both channels, all local and
remote tracks, all transfers (failing the active ones and revoking every
received object URL), and the notes transcript. A surviving peer keeps
nothing — which is exactly what the server's symmetric teardown assumes.

### Perfect negotiation

Renegotiation is not an edge case here: toggling the mic, camera or screen
share calls `addTrack`/`removeTrack`, which fires `negotiationneeded` — from
*either* side, at any time. Two peers can therefore both create offers
simultaneously (offer collision), and without a tie-breaker both sides would
error out in `have-local-offer`.

The standard "perfect negotiation" pattern resolves this with an asymmetric
pair: the **responder is polite**, the **initiator is impolite** (assigned in
the `welcome` handler, so exactly one side is each). On receiving an offer
while `makingOffer` is true or signaling state is not `stable`:

- the impolite side sets `ignoreOffer` and drops the incoming offer (its own
  offer wins);
- the polite side rolls back implicitly (`setRemoteDescription` on a
  collision) and answers the peer's offer instead.

Incoming ICE candidates that fail while `ignoreOffer` is set are expected
(they belong to the discarded offer) and swallowed; any other candidate
failure is surfaced. The implementation is `onRemoteSignal` +
`onnegotiationneeded`, and uses the parameterless
`setLocalDescription()`/`setRemoteDescription(description)` forms that make
rollback automatic.

ICE resilience: on `iceconnectionstatechange` to `disconnected`, the impolite
side attempts one `restartIce()`, and a 9 s grace timer (`ICE_GRACE_MS`) ends
the session if connectivity does not return. `connectionState === "failed"`
ends it immediately with a hint that the networks may need a TURN relay.

## Data-channel protocols

Frame formats and limits: `lib/peer-protocol.ts`. Files implementation:
`lib/file-transfer.ts` (`FileTransferManager`). Notes implementation: inline
in `lib/peer-session.ts`.

Both channels are created by the initiator, `ordered: true` and reliable
(the defaults): notes must arrive in order, and a missing file chunk is
unrecoverable. A channel with any other label is closed on arrival —
an out-of-spec peer is refused rather than guessed at.

### `notes` channel

JSON text frames only (`NoteFrame`):

```jsonc
{ "k": "note", "id": "<uuid>", "text": "...", "at": 1721990000000 }
{ "k": "typing", "on": true }
```

Received text is truncated to `MAX_NOTE_LENGTH` (20,000 chars), and unknown
or malformed frames are dropped silently. The typing indicator self-expires
after 4 s in case the peer stops typing without sending `on: false`. Notes
are rendered as markdown (`components/room/note-markdown.tsx`) with raw HTML
disabled, so a remote note cannot inject markup.

### `files` channel

A mixed scheme on one channel: **control frames are JSON strings, payload is
binary**. The receiver dispatches on the message type (`string` vs
`ArrayBuffer`).

Control frames (`FileFrame`):

```jsonc
{ "k": "offer",  "id": 1, "name": "photo.jpg", "size": 123456, "mime": "image/jpeg" }
{ "k": "done",   "id": 1 }
{ "k": "cancel", "id": 1, "by": "sender" | "receiver", "reason": "..." }
```

Binary chunks: each `ArrayBuffer` message is the little-endian **uint32
transfer id (4 bytes, `CHUNK_HEADER_BYTES`) followed by up to 16 KiB of file
data** (`CHUNK_SIZE` — the largest chunk every major SCTP stack accepts
without fuss). The id prefix lets several files stream over one channel
without interleaving corruption. Ids are namespaced per direction
(`out:1` vs `in:1`) because both peers number their own sends from 1.

Sending is sequential (`sendFiles` awaits one file at a time): one file
saturates the channel anyway, and serialising keeps per-file progress honest.

**Backpressure.** The sender never lets `bufferedAmount` run away: before
each chunk it awaits `drain()`, which resolves immediately below
`BUFFER_HIGH_WATER` (4 MiB) and otherwise waits for the
`bufferedamountlow` event, with `bufferedAmountLowThreshold` set to
`BUFFER_LOW_WATER` (512 KiB). A 100 ms poll backs up the event, covering
channel closure and browsers that fire it unreliably.

**Receive-side protections** (all enforced in `handleControlFrame` /
`handleChunk`; the receiver holds everything in memory, so these are
tab-stability limits):

| Check | Limit | Response |
| --- | --- | --- |
| Per-file size | `MAX_RECEIVE_BYTES`, 1 GiB | Offer declined with a `cancel`. |
| Concurrent incoming transfers | `MAX_ACTIVE_INCOMING_TRANSFERS`, 4 | Offer declined. A well-behaved sender streams one at a time; fanning out across many ids is how a hostile peer would dodge per-transfer caps. |
| Aggregate session memory | `MAX_SESSION_RECEIVE_BYTES`, 2 GiB | Offer declined when `inboundHeldBytes` (buffered chunks plus completed Blobs not yet disposed) plus the unreceived remainder of active transfers plus the new offer would exceed it. |
| Transfer-id reuse | — | Offer declined; accepting would orphan the previous record and leak its object URL. |
| More bytes than declared | — | Transfer failed, buffers released, `cancel` sent. |
| Peer-supplied file name | — | Reduced to a basename and capped at 180 chars (`sanitizeName`). |

Completed files become a `Blob` plus an object URL for the save link and
image previews; `dispose()` (called from `end()`) revokes every URL and
clears the buffers — without it a session would leak its whole inbox.

## How React binds to the session

Files: `hooks/use-peer-session.ts`, consumed by
`components/room/room-client.tsx`.

`PeerSession` is a plain external store: `subscribe(listener)` and
`getSnapshot()` feed React 18+'s `useSyncExternalStore`. The hook creates the
session in an effect (with a one-tick deferred `start()`, so StrictMode's
dev-only mount/unmount/mount cycle never opens a first signalling stream that
would seal the room against the surviving instance) and ends it on unmount
and on `pagehide`.

**Snapshot identity matters.** `useSyncExternalStore` re-renders only when
`getSnapshot()` returns a referentially different value, and it *requires*
that repeated calls without an intervening change return the *same* object
(otherwise it loops). So `PeerSession` caches one immutable snapshot and
rebuilds it exactly once per `emit()`; `getSnapshot` just returns the cached
reference. Mutation happens on private fields; nothing hands React a live
object that changes underneath it.

**High-frequency updates are coalesced.** A file transfer updates progress on
every 16 KiB chunk — easily thousands of times per second. `emitSoon()`
batches those into at most one snapshot per 50 ms (~20 fps), which is the
`onChange` callback the `FileTransferManager` gets. State transitions that
must be visible immediately (phase changes, notes, media toggles) use the
synchronous `emit()` instead, which also cancels any pending coalesced tick
so it cannot deliver a stale snapshot afterwards.

The media streams are intentionally *outside* the snapshot: `MediaStream`
objects are mutable and identity-stable, so views bind them to
`video.srcObject` and re-attach when `media.version` (a plain counter bumped
on every track change) moves.

## Extending it

### Adding a fourth feature (a new data channel)

Follow the pattern of `notes`/`files`; the touch points are:

1. `lib/peer-protocol.ts` — add the label to `CHANNEL` and define the frame
   types and any limits.
2. `lib/peer-session.ts` — create the channel in `openDataChannels()`
   (initiator side only; the responder receives it via `ondatachannel`),
   route it in `attachChannel()`, and decide whether `connected` should wait
   for it (today the phase flips when notes *and* files are open). Add its
   state to `build()` and its teardown to `end()`.
3. `hooks/use-peer-session.ts` — expose the new state/actions from the hook.
4. A panel component under `components/room/` wired into
   `room-client.tsx`.

Nothing server-side changes: the signalling server never sees data-channel
traffic, and a new channel only adds a few SDP lines, far inside the 96 KiB
message limit.

If the channel carries unbounded or hostile input, copy the `files` channel's
defensive posture: validate every frame, cap what you hold in memory, and
attribute cancellations correctly.

### More than two peers — a deliberate non-goal

Almost every guarantee in this codebase is *derived from* the two-party
assumption, so "support N peers" is a redesign, not a patch:

- The room seals at two and never refills; the security story ("the invite
  link admits exactly one other person, then burns") stops making sense with
  open seats.
- Perfect negotiation is pairwise — polite/impolite only tie-breaks between
  two agents. N peers means a mesh of N·(N−1)/2 connections each needing its
  own negotiation state, or an SFU, which reintroduces a media server and
  ends the "nothing flows through the server" property.
- Symmetric teardown ("either peer leaving destroys everything") is what
  makes state cleanup trivial and hijacking impossible; with N peers you need
  membership, rejoin and partial-failure semantics.
- The relay budget, tombstones and `hostPeerId` all assume one pair per
  room id.

If you need it anyway: `lib/server/rooms.ts` would become a real membership
registry (likely in a shared store — see the deployment note in the README),
`relay` would need addressing (today it is "the other occupant"), and
`PeerSession` would become a per-remote-peer object under a session
coordinator.
