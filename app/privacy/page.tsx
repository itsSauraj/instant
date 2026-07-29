import type { Metadata } from "next";

import { LegalPage, LegalSection } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Privacy | Instant",
  description:
    "What Instant sends, what it relays, and what never leaves your device. No accounts, no cookies, no analytics.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      updated="29 July 2026"
      intro="Instant runs private sessions directly between browsers. This page explains what moves where, and what never leaves your device. It is written to match how the app actually works, not to cover every eventuality with vague language."
    >
      <LegalSection heading="What we do not do">
        <ul>
          <li>No accounts. You never sign up, and we never learn who you are.</li>
          <li>No cookies, no analytics, no trackers, no ads.</li>
          <li>No database. Nothing you share is written to a server.</li>
          <li>Fonts ship with the app, so pages load without calls to font services.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="What passes through the server">
        <p>
          A small signalling server introduces browsers to each other. While you are in a
          session it holds, in memory only: the session code, your display name, join
          requests waiting for the host, and the connection offers it relays between
          participants. As with any website, requests also carry your IP address while you
          are connected.
        </p>
        <p>
          This state is never written to disk. It is released when the session ends, when
          everyone leaves, or at the latest when the room hits its 12 hour lifetime cap.
        </p>
      </LegalSection>

      <LegalSection heading="What goes directly between browsers">
        <p>
          Notes, files, the shared doc, and all audio, video and screen sharing travel peer
          to peer over WebRTC, encrypted in transit. The server does not carry this content
          and cannot read it.
        </p>
      </LegalSection>

      <LegalSection heading="What stays on your device">
        <ul>
          <li>Your display name, theme and sound preferences.</li>
          <li>Your copy of a session&apos;s shared doc, so it survives the session ending.</li>
          <li>
            A per-tab token that lets a page reload reclaim your seat. It is deleted when
            you leave the session or close the tab.
          </li>
          <li>Files you receive exist only in the browser tab that received them.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="Connection setup">
        <p>
          To find a direct path between browsers, yours contacts public STUN servers
          operated by Google and Twilio. They see your IP address; that is how this
          technique works, and it is the only third party contact the app makes. If the
          person hosting this deployment has configured a TURN relay, traffic may pass
          through it when no direct path exists. It stays encrypted either way.
        </p>
      </LegalSection>

      <LegalSection heading="Other people in your session">
        <p>
          Participants see your display name and an avatar drawn on your own device from a
          random seed. They receive whatever you choose to share, and like anyone on the
          other end of a call, they can keep copies. Share with that in mind. The host
          decides who gets in and can remove anyone.
        </p>
      </LegalSection>

      <LegalSection heading="Camera, microphone and screen">
        <p>
          Nothing is captured until you press the button for it, and your browser asks for
          permission on top of that. Invite QR codes are scanned on your device; the camera
          feed never leaves it.
        </p>
      </LegalSection>

      <LegalSection heading="Changes and contact">
        <p>
          If this page changes, the date above changes with it. Questions or concerns:
          email{" "}
          <a
            href="mailto:contact@saurabh-yadav.me"
            className="text-foreground underline underline-offset-2"
          >
            contact@saurabh-yadav.me
          </a>
          , or reach the developer via{" "}
          <a
            href="https://saurabh-yadav.me"
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            saurabh-yadav.me
          </a>{" "}
          or the{" "}
          <a
            href="https://github.com/itsSauraj/instant"
            target="_blank"
            rel="noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            GitHub repository
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
