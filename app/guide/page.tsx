import type { Metadata } from "next";
import Link from "next/link";
import {
  Camera,
  Crown,
  DoorOpen,
  FolderCheck,
  FolderDown,
  HardDriveDownload,
  KeyRound,
  Link2,
  Lock,
  MemoryStick,
  MicOff,
  Pin,
  QrCode,
  RefreshCw,
  StickyNote,
  Video,
  Wrench,
} from "lucide-react";

import { DirectPathDiagram, MeshDiagram } from "@/components/guide/diagrams";
import { EmojiFingerprintExample } from "@/components/guide/emoji-fingerprint";
import { FactRow, GuideSection, StepList } from "@/components/guide/guide-section";
import { GuideToc } from "@/components/guide/guide-toc";
import { Reveal } from "@/components/guide/reveal";
import { SiteNav } from "@/components/site-nav";

export const metadata: Metadata = {
  title: "Guide | Instant",
  description:
    "How to create a session, invite people, share notes and files, and run calls - and how to verify the end-to-end encryption yourself, emoji by emoji. The full manual for Instant.",
};

/**
 * The manual: every feature, stated plainly, with the encryption section as
 * the centerpiece. Every claim on this page is written against the source
 * files that implement it - this is the page someone reads before trusting
 * the app, so it must never say more than the code does.
 *
 * Server component shell; the only client code is the Reveal wrapper that
 * animates sections in (lib/animation.ts, reduced-motion aware).
 */
export default function GuidePage() {
  return (
    <div className="mx-auto min-h-dvh w-full max-w-5xl px-5 pt-28 pb-10 sm:px-8">
      <SiteNav />

      <main>
        <Reveal>
          <p
            data-anim="in"
            className="text-primary font-mono text-xs font-medium tracking-widest uppercase"
          >
            The manual
          </p>
          <h1 data-anim="in" className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            How Instant works
          </h1>
          <p data-anim="in" className="text-muted-foreground mt-4 max-w-2xl text-base text-pretty">
            Instant runs private sessions directly between browsers: notes, a shared doc, files,
            and calls for up to seven people. No accounts, no server-side storage. This page walks
            through every feature and, most importantly, shows you how to check the encryption
            yourself instead of taking our word for it.
          </p>
        </Reveal>

        <div className="mt-8 space-y-4 lg:grid lg:grid-cols-[230px_minmax(0,1fr)] lg:items-start lg:gap-6 lg:space-y-0">
          <GuideToc />

          <div className="space-y-4">
            {/* ------------------------------------------------ 1. Create */}
            <GuideSection
              id="create"
              step={1}
              icon={KeyRound}
              title="Create a session"
              lead="One field, one button, and you are the host."
            >
              <StepList
                items={[
                  <>
                    Enter your name on the home page. It is stored only in this browser and never
                    put in the URL - invite links get pasted and scanned, and a name embedded in
                    one would leak to everyone the link reaches. You can change it later from
                    Settings inside the room; everyone sees the new name from then on.
                  </>,
                  <>
                    Choose who can join. <strong>Private</strong> means you let each person in by
                    name; <strong>Public</strong> means anyone with the link walks straight in.
                    Private is the default, and you can flip it either way later from Settings.
                  </>,
                  <>
                    Click <strong>Create a private session</strong> (or{" "}
                    <strong>Create a public session</strong>). You are seated instantly as the
                    host; nobody approves the person who made the room.
                  </>,
                ]}
              />
              <p>
                Every session gets a code like{" "}
                <code className="text-foreground font-mono text-xs">k3f9-mq2t</code>: 8
                characters drawn from a cryptographically secure random generator, about 40 bits
                of entropy - over a trillion possibilities, each of which would have to be tried
                one request at a time. The alphabet deliberately skips I, L, O and U, so a code
                survives being read aloud or retyped, and the hyphen is display-only.
              </p>
              <p>
                You can also choose your own code: type it straight after{" "}
                <code className="text-foreground font-mono text-xs">/room/</code> in the address
                bar, or into the join field on the home page. Anything from 4 to 32 letters and
                digits works (dashes, spaces and capitals are ignored, so{" "}
                <code className="text-foreground font-mono text-xs">My-Team</code> and{" "}
                <code className="text-foreground font-mono text-xs">myteam</code> are the same
                room). If nobody is using that code, you start the session and become its host;
                if someone is, you join theirs. A code you chose is a code someone else can guess,
                which is why a private room still asks the host before anyone is seated.
              </p>
            </GuideSection>

            {/* ------------------------------------------------ 2. Invite */}
            <GuideSection
              id="invite"
              step={2}
              icon={QrCode}
              title="Invite people"
              lead="A link, a code, and a QR - all generated on your device."
            >
              <p>
                The Invite panel (the button in the room header opens it beside the room) and the
                waiting screen offer three forms of the same thing: the link, the bare code, and a
                QR code. The QR is drawn locally in your browser, never fetched
                from a hosted image service - the link <strong>is</strong> the session credential,
                so sending it to a third party to render a picture would hand your room away.
              </p>
              <p>
                On a phone, tap the camera icon in the join field on the home page and point it at
                the QR. Decoding happens entirely on-device; no camera frame leaves the browser.
                The scanned text is never navigated to directly - only a validated room code is
                used - so a hostile QR cannot redirect you off-site.
              </p>
            </GuideSection>

            {/* ----------------------------------------------- 3. Joining */}
            <GuideSection
              id="joining"
              step={3}
              icon={DoorOpen}
              title="Joining and approval"
              lead="Knowing the link gets you to the door, not through it."
            >
              <StepList
                items={[
                  <>
                    A visitor opens the invite link and is asked for their name{" "}
                    <strong>first</strong>. Nothing is sent anywhere until they choose to ask.
                  </>,
                  <>
                    They press <strong>Ask to join</strong>. Only now does a request go out.
                  </>,
                  <>
                    In a <strong>private</strong> session the host sees the request by name and
                    admits them or turns them away, from the participants panel. In a{" "}
                    <strong>public</strong> session they are seated on the spot, as long as a seat
                    is free.
                  </>,
                ]}
              />
              <p>
                The host can open or close the door at any time from Settings (or from the waiting
                screen while alone). Opening a room seats everyone already waiting, in the order
                they arrived; closing it never removes anyone - from then on new arrivals simply
                knock again. Everyone in the room can see which mode it is in from the badge next
                to the session code.
              </p>
              <p>
                Rooms hold 2 to 7 people. The host sets the limit; a new room starts at 2 and is
                raised deliberately. Lowering the limit never ejects anyone already seated - it
                only stops further joins, and the control says so the moment that happens.
              </p>
            </GuideSection>

            {/* ------------------------------------------------ 4. Reload */}
            <GuideSection
              id="reload"
              step={4}
              icon={RefreshCw}
              title="Reloads and reconnects"
              lead="A refresh is not an exit."
            >
              <p>
                Your seat is held for about 45 seconds after your connection drops. Reloading the
                page reclaims the same seat with no re-approval: a resume token lives in this
                tab&apos;s sessionStorage, so a second tab is a distinct participant and the token
                never leaks across tabs. While you are gone, the others briefly see you as
                reconnecting rather than departed.
              </p>
            </GuideSection>

            {/* ------------------------------------------------- 5. Notes */}
            <GuideSection
              id="notes"
              step={5}
              icon={StickyNote}
              title="Notes and the shared doc"
              lead="Quick messages beside a single living document."
            >
              <p>
                Notes are markdown messages written in a field that shows the formatting as you
                type: <code className="text-foreground font-mono text-xs">**bold**</code> turns
                bold on the spot, <code className="text-foreground font-mono text-xs">- </code>{" "}
                starts a list, three backticks open a code block that highlights as you type and
                carries a language picker in its corner, and the toolbar and Slack-style shortcuts
                toggle the same things - the code block button turns just the selected text into
                a block, leaving the prose around it alone. Enter sends; Shift+Enter breaks a line
                (or steps out of a code block); inside a list or code block Enter keeps editing and
                Ctrl+Enter sends. A link, whether pasted or added from the toolbar, is shown as
                a chip naming its site - with the path or your own label beside it, and the
                full address in the tooltip - in notes and in the shared doc alike. What travels
                to the
                others is plain markdown, rendered into author-labelled bubbles with typing
                indicators. Notes exist only in the participants&apos; browsers, for the length of
                the session - there is no history on any server because no server ever sees them.
              </p>
              <p>
                The shared doc is one live-synced text everyone can edit. Your browser keeps its
                own copy locally, so it survives a reload - and survives the session ending - on
                your device. You can also download it as .txt or .md at any point.
              </p>
            </GuideSection>

            {/* ------------------------------------------------- 6. Files */}
            <GuideSection
              id="files"
              step={6}
              icon={FolderDown}
              title="Files"
              lead="Chunked browser-to-browser, with three honest places to land."
            >
              <p>
                Drag files in or pick them, choose specific recipients or everyone, and the bytes
                stream in chunks directly to each receiver over the encrypted peer link. Where
                they land depends on what the receiving browser can do, best tier first:
              </p>
              <ul className="space-y-2">
                <FactRow icon={FolderCheck} title="Straight to disk (desktop Chrome and Edge)">
                  Choose a folder once and files stream directly into it, however large.
                  Filenames from peers are sanitized before touching your disk, and a name
                  collision creates &quot;report (2).pdf&quot; - an existing file is never
                  overwritten.
                </FactRow>
                <FactRow icon={HardDriveDownload} title="The browser's downloads">
                  Everywhere else with Service Worker support, files stream into the browser&apos;s
                  normal download manager. No memory ceiling.
                </FactRow>
                <FactRow icon={MemoryStick} title="In memory, as the last resort">
                  Files are held in RAM with a 1 GB per-file cap and a Save button. They live
                  there until you save them, and vanish with the tab.
                </FactRow>
              </ul>
              <p>
                <strong>Interrupted transfers resume, with one honest asymmetry.</strong> If the{" "}
                <strong>receiver</strong> reloads mid-transfer, the transfer continues from the
                last confirmed byte: the folder tier picks up the file on disk, and the memory
                tier replays confirmed bytes it kept in the browser&apos;s local database. (The
                downloads tier is the exception - a download manager cannot append, so those
                restart from zero.) If the <strong>sender</strong> reloads, no browser can re-read
                a file it was given before the reload - that is a platform rule, not ours. The
                sender re-selects the file; Instant checks it is byte-for-byte the same one (name,
                size, modification time) and the transfer genuinely continues where it stopped.
              </p>
            </GuideSection>

            {/* ------------------------------------------------- 7. Calls */}
            <GuideSection
              id="calls"
              step={7}
              icon={Video}
              title="Calls"
              lead="Up to seven people, every pair directly connected."
            >
              <div className="gap-3 sm:grid sm:grid-cols-[minmax(0,1fr)_11.25rem] sm:items-start">
                <div className="space-y-3">
                  <p>
                    Calls are in <strong>beta</strong>: they work end to end, but quality and
                    device support are still being tuned, so expect the occasional rough edge.
                    Notes, the shared doc and files are not affected.
                  </p>
                  <p>
                    Calls run as a full mesh: everyone connects directly to everyone, with no
                    media server mixing or relaying in the middle. The layout is one large stage
                    plus a filmstrip of everyone else. Pin someone to the stage for yourself, or
                    as host pin them for everyone. Controls float over the call; screen share is a
                    click away.
                  </p>
                  <p>
                    Video quality steps down as the room grows - roughly 720p with 2 people, 540p
                    with 3, 360p with 4 or 5, and about 270p with 6 or 7. That is the honest cost
                    of a mesh: each person uploads one copy of their video per peer, and a home
                    uplink does not grow with the headcount. Screen share is exempt from the
                    budget - it is usually the point of the call and compresses far better than a
                    camera.
                  </p>
                  <p>
                    The small arrow beside the microphone and camera buttons picks which device to
                    use - the microphone&apos;s arrow also offers the speaker - and the same three
                    choices sit under Devices in Settings. Switching while your microphone or
                    camera is live swaps the device in place; nobody else renegotiates or notices.
                    The choice is remembered in this browser, and a device that is unplugged next
                    time simply falls back to the system default. Speaker choice depends on the
                    browser: Chrome and Edge allow it, Firefox and Safari always use the system
                    speaker, and the pickers say so.
                  </p>
                  <p>
                    The robot avatars are generated locally from a stable per-browser seed - never
                    fetched from an avatar service - so every peer draws the same robot for the
                    same person, and no third party learns who is in your room.
                  </p>
                </div>
                <MeshDiagram />
              </div>
            </GuideSection>

            {/* -------------------------------------------------- 8. Host */}
            <GuideSection
              id="host"
              step={8}
              icon={Crown}
              title="Host controls"
              lead="One person holds the keys, and hands them over deliberately."
            >
              <p>The host admits or turns away joiners, decides whether the room is private or
              public, removes participants, sets the room limit, and can pin one person&apos;s
              video for everyone.</p>
              <ul className="space-y-2">
                <FactRow icon={MicOff} title="Moderation is honest about what it can do">
                  The host can mute someone&apos;s mic or turn off their camera - enforced, applied
                  immediately - one person at a time or everyone else at once. Turning a device{" "}
                  <strong>on</strong> is only ever a request the person accepts: no browser lets a
                  remote party switch on someone&apos;s mic or camera, and Instant does not
                  pretend otherwise.
                </FactRow>
                <FactRow icon={Pin} title="Pin for everyone">
                  A host pin overrides the automatic stage for all participants until cleared.
                  Your own local pin stays private to your browser.
                </FactRow>
                <FactRow icon={DoorOpen} title="Leaving and closing are different things">
                  The host chooses <strong>Close for everyone</strong>, which ends the session
                  immediately, or <strong>Leave</strong> after handing the room to a chosen
                  successor - who is explicitly told they are now the host. If a host simply
                  drops, the longest-seated person is promoted automatically so nobody is
                  stranded at the door.
                </FactRow>
              </ul>
              <p>
                One more honest detail: after an automatic promotion, the room still remembers its
                creator, and the role returns to them if they come back. An explicit handover is
                permanent - that is what makes it a transfer.
              </p>
            </GuideSection>

            {/* -------------------------------------------- 9. Encryption */}
            <GuideSection
              id="encryption"
              step={9}
              icon={Lock}
              title="Privacy and encryption"
              lead="What is protected, what the server sees, and how you verify it yourself."
            >
              <p>
                Everything you share - notes, doc edits, files, audio, video, screen - travels
                directly between browsers over WebRTC, encrypted in transit: DTLS for data,
                DTLS-SRTP for media. The server&apos;s only job is to introduce people and relay
                connection setup. It never carries content and never stores any; its bookkeeping
                lives in memory and is released when the session ends.
              </p>
              <DirectPathDiagram />

              <h3 className="text-foreground pt-1 text-sm font-semibold">
                How to verify it is end-to-end
              </h3>
              <p>
                Encrypted in transit is not the same as end-to-end, so Instant gives you the tool
                to check the difference. Every pair of participants shares a fingerprint: a
                SHA-256 digest computed over both sides&apos; DTLS certificate fingerprints,
                sorted so both browsers derive the identical result. It is rendered as{" "}
                <strong>10 emojis</strong> from a 64-emoji alphabet - about 60 bits on display,
                far beyond what an attacker could forge within a session.
              </p>
              <StepList
                items={[
                  <>
                    Open the participants panel: click the presence avatars, or the shield icon in
                    the header.
                  </>,
                  <>Find the person and open their key - the 10 emojis appear.</>,
                  <>
                    Compare the ten emojis out loud on the call, or in person. Order matters; both
                    of you must see the same sequence.
                  </>,
                  <>
                    If all ten match, no relay or middlebox sits between you re-encrypting
                    traffic: the encryption is end-to-end for everything the link carries. Mark
                    them <strong>verified</strong>.
                  </>,
                ]}
              />
              <EmojiFingerprintExample />
              <p>
                The shield in the room header fills as you verify more of your connected peers.
                One caveat worth knowing: a rebuilt connection - they rejoined, or reloaded - means
                a fresh certificate, so the emojis change and you verify again. That is the system
                working, not failing.
              </p>

              <h3 className="text-foreground pt-1 text-sm font-semibold">
                What never leaves your device
              </h3>
              <ul>
                <li>
                  Your name lives in this browser; it reaches the room through the session, never
                  through the URL. Nothing in a link identifies you.
                </li>
                <li>Avatars are drawn locally from a seed. QR codes are generated and scanned locally.</li>
                <li>
                  Generated room codes are not guessable in practice (~40 bits, tried one request
                  at a time), and in a private session entry still requires the host&apos;s
                  approval on top - the code alone is never enough.
                </li>
              </ul>

              <h3 className="text-foreground pt-1 text-sm font-semibold">Honest limits</h3>
              <ul>
                <li>
                  The invite link is a credential. Share it like one - anyone holding it can knock
                  on your door, and in a public session they are already through it.
                </li>
                <li>
                  A custom code is only as secret as the word you picked. Combine one with a public
                  session and anyone who guesses it is in; the waiting screen warns you when that
                  is the case.
                </li>
                <li>
                  Without a TURN relay, two people who are both behind symmetric NAT may fail to
                  connect. A deployment can configure one through optional environment variables;
                  traffic through it stays encrypted.
                </li>
                <li>
                  Files received on the in-memory tier live in RAM until you save them.
                </li>
              </ul>
            </GuideSection>

            {/* --------------------------------------- 10. Troubleshooting */}
            <GuideSection
              id="troubleshooting"
              step={10}
              icon={Wrench}
              title="Troubleshooting"
              lead="The few ways it goes wrong, and what they mean."
            >
              <ul className="space-y-2">
                <FactRow icon={Camera} title="Camera scanning will not start">
                  Scanning needs a secure context: HTTPS, or localhost. On a plain-HTTP address
                  the browser withholds the camera entirely - type the code instead.
                </FactRow>
                <FactRow icon={Link2} title="Stuck at &quot;connecting&quot;">
                  Usually symmetric NAT on both ends, which no direct path can cross. The fix is
                  a TURN relay on the deployment; without one, those two people cannot link up.
                </FactRow>
                <FactRow icon={RefreshCw} title="A transfer stopped after the sender reloaded">
                  The sender re-selects the same file and the transfer resumes from the last
                  confirmed byte. Browsers forbid re-reading a file across a reload, so this step
                  cannot be automated away.
                </FactRow>
                <FactRow icon={Lock} title="The session ended when the tab closed">
                  By design. No server holds your session, so the browser tab must stay open. A
                  reload is fine (your seat is held for ~45 seconds); an empty room is released
                  after a couple of minutes, and every room ends at its 12-hour lifetime cap.
                </FactRow>
              </ul>
            </GuideSection>
          </div>
        </div>
      </main>

      <footer className="text-muted-foreground mt-10 flex items-center justify-between border-t pt-5 text-sm">
        <Link href="/" className="hover:text-foreground font-medium transition-colors">
          Back home
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/privacy" className="hover:text-foreground transition-colors">
            Privacy
          </Link>
          <span>Instant</span>
        </div>
      </footer>
    </div>
  );
}
