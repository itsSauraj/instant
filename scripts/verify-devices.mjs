/**
 * Device selection, driven through the real UI with Chromium's fake devices:
 *
 *   1. The microphone and camera controls each have a Meet-style arrow; the
 *      microphone's opens a menu listing microphones AND speakers, the
 *      camera's lists cameras, each with a System default row.
 *   2. Choosing a microphone while it is live swaps the capture in place: the
 *      mic stays on, the live track reports the chosen device, no error shows.
 *   3. The choice is remembered (localStorage) and the Devices section of the
 *      Settings pane shows the same selection; choosing there is remembered too.
 *   4. Choosing a speaker sets the remote tiles' output device.
 *
 *   node scripts/verify-devices.mjs [baseUrl] [--headed]
 */

import {
  closeParticipantsIfOpen,
  createRoomAsHost,
  knockAndAdmit,
  launchMeshBrowser,
  makeChecker,
  newParticipant,
  openSettings,
  parseCliArgs,
  wait,
  waitForConnected,
  waitForRosterName,
} from "./mesh-shared.mjs";

const { base, headed } = parseCliArgs();
const { state, check } = makeChecker();

const browser = await launchMeshBrowser({ headed });

try {
  const host = await newParticipant(browser, "host", { name: "Hana" });
  // Headless Chromium cannot actually route audio to a fake output (setSinkId
  // rejects with AbortError), so the speaker check records what the tiles ASK
  // for rather than what the element reports afterwards.
  await host.context.addInitScript(() => {
    const original = HTMLMediaElement.prototype.setSinkId;
    window.__sinkCalls = [];
    if (original) {
      HTMLMediaElement.prototype.setSinkId = function (id) {
        window.__sinkCalls.push(id);
        return original.call(this, id);
      };
    }
  });
  const guest = await newParticipant(browser, "guest", { name: "Gus" });
  const roomUrl = await createRoomAsHost(host, base);
  await knockAndAdmit(host, guest, roomUrl);
  await waitForRosterName(host.page, "Gus");
  await waitForConnected(host.page, { peers: 1 });

  const page = host.page;
  await closeParticipantsIfOpen(page);
  await page.getByRole("tab", { name: /audio & video|a\/v/i }).first().click();
  await wait(400);

  // ------------------------------------------------------------ 1. arrows
  console.log("\nDevice arrows on the call controls");
  const micArrow = page.getByRole("button", { name: "Microphone and speaker options" });
  const camArrow = page.getByRole("button", { name: "Camera options" });
  check("the microphone control has a device arrow", await micArrow.isVisible());
  check("the camera control has a device arrow", await camArrow.isVisible());

  const menu = page.locator('[data-slot="device-menu"]');
  await micArrow.click();
  await menu.waitFor({ timeout: 5000 }).catch(() => {});
  const micMenuText = (await menu.innerText().catch(() => "")).replace(/\s+/g, " ");
  check("the microphone menu lists microphones and speakers", /Microphone.*Speaker/s.test(micMenuText), micMenuText);
  check("each list starts with System default", (micMenuText.match(/System default/g) ?? []).length === 2);
  const micItems = menu.getByRole("menuitemradio");
  check("fake microphones are listed by name", (await micItems.allInnerTexts()).some((t) => /Fake Audio Input/i.test(t)));
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});

  await camArrow.click();
  await menu.waitFor({ timeout: 5000 }).catch(() => {});
  const camMenuText = (await menu.innerText().catch(() => "")).replace(/\s+/g, " ");
  check("the camera menu lists cameras only", /^Camera/.test(camMenuText) && !/Microphone|Speaker/.test(camMenuText), camMenuText);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});

  // ------------------------------------------------- 2. live mic switch
  console.log("\nSwitching the microphone while it is live");
  await page.getByRole("button", { name: "Turn on microphone" }).click();
  await page.getByRole("button", { name: "Turn off microphone" }).waitFor({ timeout: 15_000 });
  const trackInfo = () =>
    page.evaluate(() => {
      const session = window.__instantMeshSession;
      const track = session?.getLocalStream?.().getAudioTracks()[0];
      return track ? { label: track.label, deviceId: track.getSettings().deviceId } : null;
    });
  const before = await trackInfo();

  await micArrow.click();
  await menu.waitFor({ timeout: 5000 });
  const target = menu.getByRole("menuitemradio").filter({ hasText: /Fake Audio Input 2/i }).first();
  const targetLabel = (await target.innerText()).trim();
  await target.click();
  await wait(800);

  const after = await trackInfo();
  check("the microphone stays on through the switch", await page.getByRole("button", { name: "Turn off microphone" }).isVisible());
  check(
    "the live track now comes from the chosen device",
    after !== null && after.label === targetLabel && after.label !== before?.label,
    `${before?.label} -> ${after?.label}`,
  );
  const stored = await page.evaluate(() => localStorage.getItem("instant-device-microphone"));
  check("the chosen device is remembered", Boolean(stored) && stored === after?.deviceId, `stored=${stored} live=${after?.deviceId}`);
  const errors = (await page.locator('[data-slot="call-controls"] ~ *, [role="alert"]').allInnerTexts()).filter((t) => /could not|failed|error/i.test(t));
  check("no device error is shown", errors.length === 0, errors.join(" | "));

  // ------------------------------------------------------- 3. settings
  console.log("\nThe Devices section in Settings");
  await openSettings(page);
  const section = page.locator('section[aria-label="Devices"]');
  await section.waitFor({ timeout: 10_000 });
  check("Settings has a Devices section", await section.isVisible());
  const micPicker = section.getByRole("combobox", { name: "Microphone" });
  check(
    "the Settings picker shows the microphone chosen from the arrow",
    (await micPicker.innerText()).trim() === targetLabel.trim(),
    `${await micPicker.innerText()} vs ${targetLabel}`,
  );
  await section.getByRole("combobox", { name: "Camera" }).click();
  const cameraOption = page.getByRole("option").filter({ hasText: /fake_device|Camera 1/i }).first();
  const cameraLabel = await cameraOption.innerText();
  await cameraOption.click();
  await wait(300);
  const storedCamera = await page.evaluate(() => localStorage.getItem("instant-device-camera"));
  check("choosing a camera in Settings is remembered", Boolean(storedCamera), `stored=${storedCamera} (${cameraLabel})`);

  // -------------------------------------------------------- 4. speaker
  console.log("\nSpeaker choice reaches the remote tiles");
  const speakerPicker = section.getByRole("combobox", { name: "Speaker" });
  if (await speakerPicker.isEnabled()) {
    await speakerPicker.click();
    const speaker = page.getByRole("option").filter({ hasText: /Fake Audio Output 1/i }).first();
    await speaker.click();
    await wait(600);
    const storedSpeaker = await page.evaluate(() => localStorage.getItem("instant-device-speaker"));
    const sinkCalls = await page.evaluate(() => window.__sinkCalls ?? []);
    check("the speaker choice is remembered", Boolean(storedSpeaker), `stored=${storedSpeaker}`);
    check(
      "the remote tile is told to play through the chosen speaker",
      Boolean(storedSpeaker) && sinkCalls.includes(storedSpeaker),
      `setSinkId calls: ${JSON.stringify(sinkCalls)}`,
    );
  } else {
    check("the speaker picker says the browser does not allow a choice", /system speaker/i.test(await section.innerText()));
  }

  for (const p of [host, guest]) await p.context.close();
} finally {
  await browser.close();
}

console.log(`\n${state.passes} passed, ${state.failures} failed, ${state.skips} skipped`);
process.exit(state.failures > 0 ? 1 : 0);
