/**
 * Public vs private rooms, short codes and custom codes, driven through the
 * real UI in Chromium:
 *
 *   1. The home page offers Private/Public; creating a PUBLIC session yields
 *      an 8-character code and a "Public" badge in the room header.
 *   2. A guest opening a public room's link is seated straight away - no
 *      waiting screen, no knock for the host.
 *   3. The host flips the room to PRIVATE from Settings; everyone's badge
 *      follows, and the next arrival knocks.
 *   4. The host flips back to PUBLIC; the waiting knocker is seated without
 *      anyone pressing Admit.
 *   5. A code typed straight into the address bar (`/room/my-team-…`) founds
 *      a room with the visitor as host, normalised, private by default, with
 *      the toggle available on the waiting screen and a guessability warning
 *      once it is made public.
 *   6. A code that is too short routes to the not-found page.
 *
 *   node scripts/verify-visibility.mjs [baseUrl] [--headed]
 */

import {
  admitButton,
  askToJoinButton,
  clickUntil,
  closeParticipantsIfOpen,
  ensureCapacity,
  fillNameIfAsked,
  launchMeshBrowser,
  makeChecker,
  newParticipant,
  openSettings,
  parseCliArgs,
  wait,
  waitForRosterName,
  waitingForApproval,
} from "./mesh-shared.mjs";

const { base, headed } = parseCliArgs();
const { state, check } = makeChecker();

const GENERATED = /\/room\/([0-9a-hjkmnp-tv-z]{8})(?:[/?#]|$)/;

const visibilityBadge = (page) => page.locator('[data-slot="visibility-badge"]').first();
// `:visible`, because the Settings tab keeps its (hidden) copy of the control
// mounted while the waiting screen shows another; only the visible one clicks.
const visibleToggle = (page) => page.locator('[data-slot="visibility-toggle"]:visible').first();
const visibilityRadio = (page, value) =>
  page
    .locator(`[data-slot="visibility-toggle"] [role="radio"][data-visibility="${value}"]:visible`)
    .first();

/** Polls until `predicate` holds or the timeout passes. */
async function eventually(predicate, { timeout = 15_000, every = 300 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() > deadline) return false;
    await wait(every);
  }
}

async function badgeReads(page, expected, { timeout = 15_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await visibilityBadge(page).getAttribute("data-visibility").catch(() => null);
    if (value === expected) return true;
    if (Date.now() > deadline) return false;
    await wait(300);
  }
}

/** Selects one side of the segmented control and waits for the room to echo it. */
async function flipVisibility(page, value) {
  const radio = visibilityRadio(page, value);
  await radio.waitFor({ timeout: 10_000 });
  return clickUntil(radio, async () => (await radio.getAttribute("aria-checked")) === "true", {
    attempts: 10,
    delay: 300,
  });
}

const browser = await launchMeshBrowser({ headed });

try {
  // ------------------------------------------------------------- 1. create
  console.log("\nCreating a PUBLIC session from the home page");
  const host = await newParticipant(browser, "host", { name: "Hana" });
  await host.page.goto(base);
  await fillNameIfAsked(host.page, "Hana");

  const homeToggle = host.page.locator('[data-slot="visibility-toggle"]').first();
  await homeToggle.waitFor({ timeout: 20_000 });
  check("home page shows the Private/Public control", await homeToggle.isVisible());
  check(
    "Private is selected by default",
    (await visibilityRadio(host.page, "private").getAttribute("aria-checked")) === "true",
  );

  await flipVisibility(host.page, "public");
  const createPublic = host.page.getByRole("button", { name: "Create a public session", exact: true });
  check("the create button relabels to \"Create a public session\"", await createPublic.isVisible());

  const navigated = await clickUntil(createPublic, async () => /\/room\//.test(host.page.url()), {
    attempts: 20,
  });
  check("creating navigates into a room", navigated, host.page.url());
  const roomUrl = host.page.url();
  const match = GENERATED.exec(roomUrl);
  check("the generated code is 8 characters from the safe alphabet", Boolean(match), roomUrl);

  check("the host's header badge reads Public", await badgeReads(host.page, "public"));

  // The toggle appears once the server's welcome confirms host-ness, a beat
  // after the (optimistic) badge, so wait for it rather than counting at once.
  await visibleToggle(host.page).waitFor({ timeout: 15_000 }).catch(() => {});
  check(
    "the waiting screen offers the host the same toggle",
    await visibleToggle(host.page).isVisible().catch(() => false),
  );
  const lobbyBadge = host.page.locator('[data-slot="badge"][data-visibility="public"]').first();
  check(
    "the waiting screen says the room is open to anyone with the link",
    /open to anyone/i.test(await lobbyBadge.innerText().catch(() => "")),
  );

  const dismiss = host.page.getByRole("button", { name: /close and wait in the room/i }).first();
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {});

  // ------------------------------------------------------------ 2. walk in
  console.log("\nA guest opens the public link");
  const guest = await newParticipant(browser, "guest", { name: "Gus" });
  await guest.page.goto(roomUrl);
  const gateField = guest.page.getByLabel(/your name/i).first();
  await gateField.waitFor({ timeout: 20_000 });
  check("the guest still meets the name gate before anything is sent", await gateField.isVisible());
  await fillNameIfAsked(guest.page, "Gus");
  await clickUntil(askToJoinButton(guest.page), async () => !(await gateField.isVisible().catch(() => false)), {
    attempts: 15,
  });

  await waitForRosterName(host.page, "Gus", { timeout: 30_000 });
  check("the guest is seated without the host admitting anyone", true);
  check(
    "the guest never saw the waiting-for-approval screen",
    !(await waitingForApproval(guest.page).isVisible().catch(() => false)),
  );
  check(
    "the host was shown no admit button",
    !(await admitButton(host.page, "Gus").isVisible().catch(() => false)),
  );
  check("the guest's header badge reads Public too", await badgeReads(guest.page, "public"));

  // ----------------------------------------------------- 3. flip to private
  console.log("\nThe host closes the door from Settings");
  await closeParticipantsIfOpen(host.page);
  await openSettings(host.page);
  const hostGroup = host.page.locator('[role="group"][aria-label="Who can join" i]').first();
  await hostGroup.waitFor({ timeout: 10_000 });
  check("the host panel has a \"Who can join\" control", await hostGroup.isVisible());
  check("the host can flip the room to Private", await flipVisibility(host.page, "private"));
  check("the host's badge follows to Private", await badgeReads(host.page, "private"));
  check("the guest's badge follows to Private", await badgeReads(guest.page, "private"));

  // Capacity 2 is full with two seated, so raise it before the third arrives.
  await ensureCapacity(host, 3);

  const third = await newParticipant(browser, "third", { name: "Tam" });
  await third.page.goto(roomUrl);
  await fillNameIfAsked(third.page, "Tam");
  await askToJoinButton(third.page).click({ timeout: 10_000 }).catch(() => {});
  await waitingForApproval(third.page).waitFor({ timeout: 20_000 }).catch(() => {});
  check(
    "a new arrival at the now-private room waits for approval",
    await waitingForApproval(third.page).isVisible().catch(() => false),
  );
  await admitButton(host.page, "Tam").waitFor({ timeout: 15_000 }).catch(() => {});
  check(
    "the host sees the knock",
    await admitButton(host.page, "Tam").isVisible().catch(() => false),
  );

  // ------------------------------------------------------ 4. flip to public
  console.log("\nThe host opens the door again while someone is waiting");
  // The knock auto-opened the participants drawer over the right edge, where
  // the Settings controls sit; close it so the click lands on the toggle.
  await closeParticipantsIfOpen(host.page);
  await openSettings(host.page);
  check("the host can flip the room back to Public", await flipVisibility(host.page, "public"));
  // Seated means: the knock is gone from the host's queue AND the knocker's
  // waiting screen has been replaced by the room. The roster text alone would
  // not do - it also prints the names of people still asking to join.
  const seated = await eventually(
    async () =>
      !(await admitButton(host.page, "Tam").isVisible().catch(() => false)) &&
      !(await waitingForApproval(third.page).isVisible().catch(() => false)),
    { timeout: 20_000 },
  );
  check("opening the room seats the waiting knocker without an Admit click", seated);
  await waitForRosterName(host.page, "Tam", { timeout: 20_000 });
  check("the host's roster lists the newcomer", true);
  check("the late joiner's badge reads Public", await badgeReads(third.page, "public"));

  for (const p of [host, guest, third]) await p.context.close();

  // -------------------------------------------------------- 5. custom code
  console.log("\nA custom code typed into the address bar");
  const custom = `My-Team-${Math.floor(Math.random() * 1e6)}`;
  const normalised = custom.toLowerCase().replace(/[^0-9a-z]/g, "");
  const founder = await newParticipant(browser, "founder", { name: "Fia" });
  await founder.page.goto(`${base}/room/${custom}`);
  const founderGate = founder.page.getByLabel(/your name/i).first();
  await founderGate.waitFor({ timeout: 20_000 });
  const gateCopy = await founder.page.locator("form").innerText().catch(() => "");
  check(
    "the gate names the normalised code and explains the founder case",
    gateCopy.includes(normalised) && /become(s)? its host/i.test(gateCopy),
    gateCopy.slice(0, 200),
  );
  await fillNameIfAsked(founder.page, "Fia");
  await clickUntil(askToJoinButton(founder.page), async () => !(await founderGate.isVisible().catch(() => false)), {
    attempts: 15,
  });
  const waitingHeading = founder.page.getByText(/waiting for others to join/i).first();
  await waitingHeading.waitFor({ timeout: 20_000 }).catch(() => {});
  check("the visitor founds the room and lands in the host's waiting screen", await waitingHeading.isVisible());
  // The code badge is a tooltip trigger, so Radix stamps it
  // data-slot="tooltip-trigger" rather than "badge"; find it by its monospace
  // class instead. textContent rather than innerText: the header sits behind
  // the waiting screen's cover.
  const codeBadge = founder.page.locator("header .font-mono").first();
  const codeText = ((await codeBadge.textContent().catch(() => "")) ?? "").trim();
  check(
    "the header shows the custom code, normalised and ungrouped",
    codeText === normalised,
    `read "${codeText}", wanted "${normalised}"`,
  );
  check("a room founded from the address bar is private by default", await badgeReads(founder.page, "private"));

  await visibleToggle(founder.page).waitFor({ timeout: 15_000 }).catch(() => {});
  check(
    "the founder can flip the custom-code room to Public from the waiting screen",
    await flipVisibility(founder.page, "public"),
  );
  const warning = founder.page.locator('[data-slot="guessable-warning"]').first();
  await warning.waitFor({ timeout: 10_000 }).catch(() => {});
  check(
    "making a custom-code room public shows the guessability warning",
    await warning.isVisible().catch(() => false),
  );
  await founder.context.close();

  // ------------------------------------------------------- 6. invalid code
  console.log("\nA code that is too short");
  const lost = await newParticipant(browser, "lost");
  await lost.page.goto(`${base}/room/abc`);
  await lost.page.getByText(/session code isn/i).first().waitFor({ timeout: 15_000 }).catch(() => {});
  check(
    "a 3-character code routes to the not-found page",
    await lost.page.getByText(/session code isn/i).first().isVisible().catch(() => false),
  );
  await lost.context.close();
} finally {
  await browser.close();
}

console.log(`\n${state.passes} passed, ${state.failures} failed, ${state.skips} skipped`);
process.exit(state.failures > 0 ? 1 : 0);
