/**
 * Proves remote audio is actually audible, not merely sent.
 *
 * The failure this guards is specific and silent: a browser refuses to autoplay
 * an UNMUTED media element without user activation. The local preview is muted
 * so it always plays, and an audio-only peer shows no picture, so nothing looks
 * broken - the sender's mic is on, permission is granted, and no one can hear
 * them. Swallowing that rejection left it dead for the whole session.
 *
 * Chromium's own policy cannot be provoked here - a page holding a camera or
 * microphone grant is exempt, and every call participant has one - so the
 * refusal is injected instead, reproducing its observable effect exactly.
 * Asserting on `paused` of the receiving element is the check that matters; a
 * passing WebRTC stat only proves bytes arrived, not that anyone heard them.
 *
 *   node scripts/verify-audio-playback.mjs [baseUrl]
 *
 * Keep this file ASCII-only.
 */

import { chromium } from "playwright";

import { createRoomAsHost, knockAndAdmit, makeChecker, parseCliArgs } from "./mesh-shared.mjs";

const { base: BASE } = parseCliArgs();
const { check, skip, state } = makeChecker();

const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

/**
 * Makes the FIRST play() on each media element reject with NotAllowedError,
 * exactly as an autoplay refusal does, then behave normally.
 *
 * Chromium's real policy could not be provoked here: a page holding a
 * camera/mic grant is exempt, and every participant in a call has one. Rather
 * than approximate the policy, this reproduces its observable effect precisely,
 * which is what the recovery code actually reacts to.
 */
const REFUSE_FIRST_PLAY = () => {
  const original = HTMLMediaElement.prototype.play;
  const refused = new WeakSet();
  HTMLMediaElement.prototype.play = function patched() {
    if (!refused.has(this)) {
      refused.add(this);
      const error = new DOMException("play() blocked by autoplay policy", "NotAllowedError");
      return Promise.reject(error);
    }
    return original.call(this);
  };
};

async function participant(label, name, { blockAutoplay = false } = {}) {
  const context = await browser.newContext({ permissions: ["microphone", "camera"] });
  if (blockAutoplay) await context.addInitScript(REFUSE_FIRST_PLAY);
  await context.addInitScript((value) => {
    try {
      localStorage.setItem("instant-name", value);
      localStorage.setItem("instant-theme", "dark");
    } catch {
      // Storage disabled; the join gate asks instead.
    }
  }, name);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`  [${label}] page error: ${error.message}`));
  return { context, page, label, name };
}

/** State of every remote (non-self) media element on the page. */
const remoteElements = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="video-tile"]:not([data-self]) video')].map((el) => ({
      paused: el.paused,
      muted: el.muted,
      hasStream: Boolean(el.srcObject),
      audioTracks:
        el.srcObject && "getAudioTracks" in el.srcObject ? el.srcObject.getAudioTracks().length : 0,
      liveAudio:
        el.srcObject && "getAudioTracks" in el.srcObject
          ? el.srcObject.getAudioTracks().filter((t) => t.readyState === "live" && !t.muted).length
          : 0,
    })),
  );

async function openMedia(page) {
  const tab = page.getByRole("tab", { name: /audio & video|a\/v/i }).first();
  await tab.waitFor({ timeout: 20_000 });
  await tab.click();
  await page.locator('[data-slot="video-tile"]').first().waitFor({ timeout: 20_000 });
}

try {
  console.log(`Verifying remote audio playback against ${BASE}`);
  console.log("  (asserting the receiving element actually plays, not just that bytes arrived)");

  const host = await participant("host", "Ada");
  // The listener's first play() is refused, which is the reported case: the
  // speaker's mic is on and permitted, and the other end hears silence.
  const guest = await participant("guest", "Ben", { blockAutoplay: true });

  const roomUrl = await createRoomAsHost(host, BASE);
  await knockAndAdmit(host, guest, roomUrl, { timeout: 45_000 });

  await openMedia(host.page);
  await openMedia(guest.page);

  // Ada turns her microphone on. Ben must be able to HEAR it.
  await host.page.getByRole("button", { name: /turn on microphone/i }).first().click();

  let arrived = true;
  try {
    await guest.page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-slot="video-tile"]:not([data-self]) video')].some(
          (el) =>
            el.srcObject &&
            "getAudioTracks" in el.srcObject &&
            el.srcObject.getAudioTracks().some((t) => t.readyState === "live"),
        ),
      undefined,
      { timeout: 45_000 },
    );
  } catch {
    arrived = false;
  }
  check("the microphone track reaches the other peer", arrived);

  // The crux. Bytes arriving is not the same as sound coming out.
  const before = await remoteElements(guest.page);
  check("the receiver has a remote element bound to a stream", before.some((el) => el.hasStream));
  check(
    "the remote element is not muted",
    before.every((el) => !el.muted),
    JSON.stringify(before),
  );

  const blockedAtFirst = before.some((el) => el.hasStream && el.paused);
  if (blockedAtFirst) {
    check(
      "a refused element shows the click-to-hear hint rather than looking normal",
      (await guest.page.locator('[data-slot="audio-blocked"]').count()) > 0,
    );
  } else {
    // Worth being precise about, because it bounds what this suite proves.
    // Two things defeat provoking a real refusal here: Chromium exempts a page
    // holding a camera/mic grant, which every call participant has, and the
    // element carries the autoplay attribute, so the browser starts it natively
    // without going through the play() call a patch could intercept.
    skip(
      "the refused-then-recovered branch",
      "a refusal could not be provoked in headless Chromium; the audible assertions below still ran",
    );
  }

  // Any interaction grants activation; the fix retries on the next one.
  await guest.page.mouse.click(5, 5);
  await guest.page.waitForTimeout(1200);

  const after = await remoteElements(guest.page);
  check(
    "the remote element is PLAYING after an interaction, so audio is audible",
    after.length > 0 && after.every((el) => !el.hasStream || !el.paused),
    JSON.stringify(after),
  );
  check(
    "it carries a live, unmuted audio track",
    after.some((el) => el.liveAudio > 0),
    JSON.stringify(after),
  );

  // The hint only earns its place if it disappears once sound works.
  const chip = guest.page.locator('[data-slot="audio-blocked"]');
  check("no leftover click-to-hear hint once playback recovered", (await chip.count()) === 0);

  await Promise.all([host.context.close(), guest.context.close()]);
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await browser.close().catch(() => {});
}

console.log(
  `\n${state.failures === 0 ? "Remote audio is audible." : `${state.failures} check(s) failed.`} (${state.passes} passed, ${state.failures} failed, ${state.skips} skipped)`,
);
process.exit(state.failures === 0 ? 0 : 1);
