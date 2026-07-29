/**
 * Reproduces the signalling race that produces
 *   "Failed to execute 'addIceCandidate' on 'RTCPeerConnection':
 *    The remote description is null"
 * and asserts the pair still connects.
 *
 * Signalling payloads are independent POSTs with no ordering guarantee, so an
 * ICE candidate can overtake the SDP it belongs to. It shows up on mobile
 * because the SDP is larger and the uplink slower. To make it deterministic
 * rather than hoping for the right timing, `fetch` is patched in-page to hold
 * description POSTs back while candidates go straight out.
 *
 *   node scripts/verify-ice-race.mjs [baseUrl]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
/** Long enough that candidates certainly win, short enough to keep the run brisk. */
const SDP_DELAY_MS = 1200;

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const roomId = () =>
  Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * 32)]).join("");

let failures = 0;
const check = (name, ok, detail) => {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
};

/** Delays only the SDP, so ICE candidates arrive first. */
const DELAY_SDP = (delayMs) => {
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    const body = init?.body;
    if (
      init?.method === "POST" &&
      String(url).includes("/api/signal/") &&
      typeof body === "string" &&
      body.includes('"kind":"description"')
    ) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return original(input, init);
  };
};

const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

/** Every console error and in-page error, so the throw cannot pass unnoticed. */
async function newPeer(label, collected) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("webpack-hmr")) {
      collected.push(`[${label}] ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => collected.push(`[${label}] ${e.message}`));
  await page.addInitScript(DELAY_SDP, SDP_DELAY_MS);
  return { context, page, label };
}

const statusBadge = (page) => page.locator('[data-slot="badge"][aria-live="polite"]');

async function run() {
  const errors = [];
  const room = `${BASE}/room/${roomId()}`;

  // Both sides delay their SDP: the offer and the answer each get overtaken.
  const a = await newPeer("host", errors);
  const b = await newPeer("guest", errors);

  await a.page.goto(room);
  await a.page.getByText(/waiting for one other person/i).waitFor({ timeout: 20_000 });
  await b.page.goto(room);

  let connected = true;
  try {
    await statusBadge(a.page).getByText("Peer connected").waitFor({ timeout: 45_000 });
    await statusBadge(b.page).getByText("Peer connected").waitFor({ timeout: 45_000 });
  } catch {
    connected = false;
  }
  check("both peers connect even though candidates arrived before the SDP", connected);

  // The session catches this and renders it as a role=alert banner rather than
  // logging it, so the console alone is not enough to detect the bug - collect
  // the banner text as well and assert over both.
  const banners = [];
  for (const peer of [a, b]) {
    const alerts = await peer.page.locator('[role="alert"]').allInnerTexts();
    for (const text of alerts) banners.push(`[${peer.label}] ${text}`);
  }

  const iceFailures = [...errors, ...banners].filter((line) =>
    /addIceCandidate|remote description (is|was) null/i.test(line),
  );
  check(
    "no addIceCandidate failure surfaced, in the console or the UI",
    iceFailures.length === 0,
    iceFailures.join(" | ") || undefined,
  );

  const negotiation = banners.filter((t) => /negotiation failed/i.test(t));
  check(
    "neither peer shows a negotiation error banner",
    negotiation.length === 0,
    negotiation.join(" | ") || undefined,
  );

  // The channels must actually be usable, not merely reported as connected.
  if (connected) {
    await a.page.getByRole("tab", { name: /notes/i }).click();
    await b.page.getByRole("tab", { name: /notes/i }).click();
    await a.page.getByRole("textbox", { name: "Note" }).fill("survived the race");
    await a.page.getByRole("textbox", { name: "Note" }).press("Enter");
    let delivered = true;
    try {
      await b.page.getByText("survived the race").waitFor({ timeout: 15_000 });
    } catch {
      delivered = false;
    }
    check("the data channel works after the out-of-order negotiation", delivered);
  }

  mkdirSync("artifacts/screenshots", { recursive: true });
  writeFileSync("artifacts/screenshots/ice-race-host.png", await a.page.screenshot());

  if (errors.length > 0) {
    console.log("\n  Collected browser errors:");
    for (const line of errors.slice(0, 10)) console.log(`    ${line}`);
  }

  await Promise.all([a.context.close(), b.context.close()]);
}

try {
  console.log(`Verifying the ICE/SDP ordering race against ${BASE}`);
  console.log(`  (holding every description POST back by ${SDP_DELAY_MS}ms)`);
  await run();
} catch (error) {
  failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nAll ICE-race checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
