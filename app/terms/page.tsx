import type { Metadata } from "next";

import { LegalPage, LegalSection } from "@/components/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service | Instant",
  description:
    "The terms for using Instant: a free peer-to-peer session tool. Own what you share, be decent, expect no guarantees.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="29 July 2026"
      intro="The short version: Instant is a free tool that connects browsers directly so people can share notes, files and live media. Own what you share, be decent to the people you share it with, and expect no guarantees. The longer version follows."
    >
      <LegalSection heading="The service">
        <p>
          Instant creates temporary sessions between up to seven browsers. Content travels
          peer to peer; a small server only introduces participants and relays connection
          setup. Sessions are ephemeral: rooms expire on their own and nothing is stored
          server side. The service is free, and it may change or shut down at any time
          without notice.
        </p>
      </LegalSection>

      <LegalSection heading="Your content">
        <p>
          Whatever you share in a session goes to the other participants, not to us. We do
          not store it, review it, or moderate it, and we could not if we wanted to. You
          are responsible for what you share and you must have the right to share it.
          Other participants can keep copies of anything you send them.
        </p>
      </LegalSection>

      <LegalSection heading="Acceptable use">
        <ul>
          <li>No unlawful content or activity.</li>
          <li>No harassment or abuse of other participants.</li>
          <li>
            No attempts to disrupt the service or other people&apos;s sessions, including
            flooding the signalling server or probing sessions you were not invited to.
          </li>
          <li>No impersonating someone else to get admitted into a session.</li>
        </ul>
      </LegalSection>

      <LegalSection heading="The host runs the room">
        <p>
          Every session has a host. The host decides who gets in, can remove anyone, and
          can end the session for everyone. By joining a session you accept that. By
          hosting one you accept responsibility for who you let in.
        </p>
      </LegalSection>

      <LegalSection heading="No warranty">
        <p>
          The service is provided as is and as available, with no warranty of any kind.
          Connections depend on browsers, networks and devices outside our control, and a
          session can fail or drop at any moment. Do not rely on Instant as the only copy
          of anything important.
        </p>
      </LegalSection>

      <LegalSection heading="Liability">
        <p>
          To the maximum extent permitted by law, the developer is not liable for any
          damages arising from use of the service, including lost data, missed
          connections, or the actions of other participants.
        </p>
      </LegalSection>

      <LegalSection heading="Changes">
        <p>
          These terms may change; the date above tells you when they last did. Using the
          service after a change means you accept the updated terms.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
