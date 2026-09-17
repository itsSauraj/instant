# Instant

Instant links exactly two browsers into a private, ephemeral session. The two
peers exchange notes, files and live audio/video directly over an encrypted
WebRTC connection; the server only introduces them and then steps out of the
data path. There are no accounts, no database, and nothing is stored
server-side.

## Quick start

```bash
npm install
npm run dev
```

Open the printed URL (default `http://localhost:3000`), click
**Create a private session**, and open the invite link shown in the lobby in a
second browser. For a quick smoke test, two tabs in the same browser profile
work fine - each tab joins as an independent peer.

Requires Node.js and a current Chromium-, Firefox- or WebKit-based browser.
No configuration is needed; see [Configuration](#configuration) for the one
optional knob (a TURN relay).

## Features

| Feature | Transport |
| --- | --- |
| Notes, rendered as GitHub-flavored markdown with syntax highlighting (raw HTML is never rendered) | `notes` data channel - ordered, reliable, JSON frames |
| File transfer with progress, cancellation and image previews | `files` data channel - ordered, reliable, 16 KiB binary chunks with a 4-byte transfer-id header |
| Microphone, camera and screen share | RTP media tracks on the same peer connection (screen share takes over the outgoing video sender while it is on) |

Both data channels and all media tracks ride one `RTCPeerConnection`, so
turning on a device mid-session only triggers renegotiation, never a new
connection.

## Architecture

```text
        Browser A                                Browser B
            |                                        |
            |  GET /api/signal/<roomId>  (SSE join)  |
            +----------------+   +------------------+
                             v   v
                      Signalling route
                (in-memory room registry,
                 relays SDP offers/answers
                 and ICE candidates only)
                             |
        ... introductions complete, server steps out ...

        Browser A <=============================> Browser B
                   RTCPeerConnection (DTLS-SRTP)
                   - "notes" data channel
                   - "files" data channel
                   - audio / video / screen tracks
```

The signalling route is used only for introductions: joining the room,
relaying WebRTC session descriptions and ICE candidates, and announcing
departures. Every note, file byte and media frame flows directly between the
two browsers. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the wire
protocol, state machines and extension points.

## Host authority

The first person into a room is the **host**. Only the host may deliberately
end the session - the guest's "End session" control stays locked until the
host grants it from the host panel shown above the room tabs (and the host can
revoke the grant again). The server enforces this: a `bye` from an
unauthorised guest is refused with `403` and the room is untouched.

This governs only the *deliberate* end action. Either peer closing its tab or
losing its connection still destroys the session for both, by design - a
two-party session has nothing meaningful to preserve once one party is gone.

## Security model

What the code guarantees, as implemented in `lib/server/rooms.ts` and
`lib/ids.ts`:

- Exactly two peers per session. The room **seals** when the second peer
  joins, and a vacated slot is never refilled - a third party cannot take
  over a seat that opens up mid-session.
- Either peer leaving (deliberately or by dropping) destroys the session for
  both sides. There is no half-open state to hijack.
- A sealed room's code is **tombstoned** when the room dies, so the invite
  link cannot be reopened for a fresh session (15-minute tombstone; the id
  space makes accidental reuse implausible anyway).
- Generated room codes are 40 bits from a CSPRNG (`crypto.getRandomValues`,
  8 characters of a 32-character alphabet) - too many to enumerate against a
  server that answers one code at a time. A **custom** code is anything you
  type after `/room/` (4 to 32 letters and digits; dashes, spaces and case are
  ignored), and is exactly as guessable as you make it.
- Sessions are **private** by default: knowing the code gets you to the door,
  and the host lets each person in by name. A **public** session seats anyone
  with the code straight away, up to the seat limit, so there the code is the
  only barrier. The founder picks on the home page and the host can flip it
  either way mid-session; opening a room seats whoever was already waiting.
- WebRTC encrypts everything in transit with DTLS-SRTP. This holds even when
  a TURN relay carries the traffic; the relay sees only ciphertext.
- Nothing is persisted server-side. Rooms live in process memory for the
  duration of the negotiation and are gone when the session ends.

Honest limitations:

- **The invite link is the credential.** Anyone the link leaks to can take
  the free seat before the intended person does. Send it over a channel you
  trust.
- **The signalling registry is in-memory in a single Node process.** Running
  multiple instances or serverless functions breaks the two-peer and
  tombstone guarantees, because each instance has its own registry. See
  [Deployment](#deployment).
- **Symmetric NAT can defeat direct connection.** Without a TURN relay
  configured, two peers who are both behind symmetric NAT may simply fail to
  connect.
- **Received files are held in browser memory** (chunk buffers, then a Blob)
  until you save them and the session ends. Per-file and per-session caps
  exist (1 GiB per file, 2 GiB per session), but very large transfers still
  cost RAM.

## Configuration

None required. The only environment variables the app reads are the three
optional TURN settings in `lib/peer-session.ts` - see
[.env.example](.env.example). A TURN server relays encrypted traffic between
peers behind symmetric NAT, where no direct path can be established. Note
that `NEXT_PUBLIC_*` values are compiled into the client bundle: a long-lived
TURN credential placed there is visible to anyone who loads the page.

## Deployment

The app is built to run on a **single long-lived Node process**:

```bash
npm run build
npm start
```

Two properties of the signalling route make this a hard requirement, not a
preference:

- `GET /api/signal/<roomId>` holds an open SSE stream per peer for the whole
  session.
- Room state (occupants, sealed flag, tombstones) lives in module-level
  memory in `lib/server/rooms.ts`.

Any platform that runs multiple instances or short-lived serverless functions
will route the two peers of one room to different processes, and the
guarantees above silently fail. `docs/PLAN.md` mentions Vercel as a target;
to be straight about it: the default in-memory registry only holds on a
single instance. Deploying to a multi-instance or serverless platform means
moving the room registry to a shared store (e.g. Redis) - `lib/server/rooms.ts`
is the single file that would change, plus a pub/sub path to replace the
in-process `emit` callbacks.

## Verification scripts

The `scripts/` directory drives the real app (Playwright is already in
`devDependencies`). Start a dev server first, then point the scripts at it:

```bash
node scripts/debug-home.mjs http://127.0.0.1:3000        # console/page errors, failed requests
node scripts/verify-signalling.mjs http://127.0.0.1:3000 # signalling route security invariants
node scripts/verify-e2e.mjs http://127.0.0.1:3000        # full two-browser session
node scripts/verify-recreate.mjs http://127.0.0.1:3000   # end-and-recreate regression checks
node scripts/verify-host-authority.mjs http://127.0.0.1:3000  # host/guest end-permission rules
```

The Playwright suites accept `--headed` to show the two browser windows side
by side (with slowMo) instead of running headless. They write screenshots of
the key states to `artifacts/screenshots/`.

## File layout

| Path | Responsibility |
| --- | --- |
| `app/page.tsx`, `components/home/home-hero.tsx` | Landing page; create/join a session |
| `app/room/[id]/page.tsx`, `components/room/room-client.tsx` | The room UI: tabs, status, overlays |
| `app/api/signal/[roomId]/route.ts` | The entire backend - SSE join stream plus the signalling POST |
| `lib/server/rooms.ts` | In-memory room registry: two-peer seal, tombstones, TTLs, host permission |
| `lib/signal-protocol.ts` | Wire types and limits shared by server and client |
| `lib/signal-client.ts` | Browser side of signalling: fetch-based SSE reader and POSTs |
| `lib/peer-session.ts` | The client session state machine: WebRTC, perfect negotiation, media, teardown |
| `lib/peer-protocol.ts` | Data-channel frame formats, chunk framing, size/memory limits |
| `lib/file-transfer.ts` | The `files` channel: chunking, backpressure, reassembly, receive caps |
| `lib/ids.ts` | CSPRNG room ids and per-connection tokens |
| `hooks/use-peer-session.ts` | Binds the session store to React via `useSyncExternalStore` |
| `components/room/host-panel.tsx` | Host-only toggle delegating the right to end the session |
| `components/room/notes-panel.tsx`, `note-markdown.tsx` | Notes UI and markdown rendering |
| `components/room/files-panel.tsx` | File send/receive UI, drag-and-drop, previews |
| `components/room/media-panel.tsx` | Mic/camera/screen controls and video elements |
| `scripts/` | Playwright and HTTP verification suites (see above) |
| `docs/ARCHITECTURE.md` | Protocol and state-machine detail for people changing this code |
| `docs/PLAN.md` | The product owner's original plan document |
