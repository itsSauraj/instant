/**
 * Verifies the "extras" modules: QR invite, the Web Audio sound engine,
 * toasts, and the hidden-tab title alert.
 *
 *   node scripts/verify-extras.mjs [baseUrl] [--headed]
 *
 * Strategy: the real component/hook sources are bundled with esbuild (fetched
 * via npx, nothing added to package.json) and injected into the live app page,
 * so they run against the app's real stylesheet and theme bootstrap. The QR is
 * then screenshot in both themes and DECODED with jsqr; the sound cues are
 * rendered through the exact live signal chain inside an OfflineAudioContext
 * and measured sample-by-sample.
 *
 * ASCII only, deliberately.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.argv[2]?.startsWith("http") ? process.argv[2] : "http://127.0.0.1:3111";
const HEADED = process.argv.includes("--headed");

const QR_URL = "http://127.0.0.1:3111/room/abcdefgh23456789";
const QR_URL_2 = "http://127.0.0.1:3111/room/x2y3z4a5b6c7d8e9";

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

// ------------------------------------------------------------------ bundling

const HARNESS_SOURCE = `
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QrInvite } from "@/components/room/qr-invite";
import { SoundToggle } from "@/components/room/sound-toggle";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ToastViewport } from "@/components/ui/toast";
import { pushToast, dismissToast, getToasts, MAX_VISIBLE_TOASTS } from "@/hooks/use-toasts";
import { useTitleAlert } from "@/hooks/use-title-alert";
import * as sound from "@/lib/sound";

function TitleProbe() {
  const [n, setN] = useState(0);
  useEffect(() => {
    window.__bumpActivity = () => setN((v) => v + 1);
  }, []);
  useTitleAlert(n);
  return null;
}

function App() {
  const [qrUrl, setQrUrl] = useState("");
  useEffect(() => {
    window.__setQrUrl = setQrUrl;
    window.__harnessReady = true;
  }, []);
  return (
    <TooltipProvider>
      {qrUrl ? (
        <div id="qr-host" style={{ position: "fixed", top: 96, left: 16, zIndex: 9998, width: 280 }}>
          <QrInvite url={qrUrl} />
        </div>
      ) : null}
      <div id="sound-toggle-host" style={{ position: "fixed", top: 400, left: 16, zIndex: 9998 }}>
        <SoundToggle />
      </div>
      <ToastViewport />
      <TitleProbe />
    </TooltipProvider>
  );
}

const host = document.createElement("div");
host.id = "extras-harness";
document.body.appendChild(host);
createRoot(host).render(<App />);
window.__extras = { sound, pushToast, dismissToast, getToasts, MAX_VISIBLE_TOASTS };
`;

function buildHarnessBundle() {
  const npxCli = path.join(
    path.dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npx-cli.js",
  );
  const result = spawnSync(
    process.execPath,
    [
      npxCli,
      "--yes",
      "esbuild@0.25.9",
      "--bundle",
      "--format=iife",
      "--platform=browser",
      "--jsx=automatic",
      "--loader=tsx",
      "--tsconfig=tsconfig.json",
      '--define:process.env.NODE_ENV="production"',
      "--target=chrome110",
      "--log-level=warning",
    ],
    { cwd: ROOT, input: HARNESS_SOURCE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0 || !result.stdout) {
    throw new Error(`esbuild failed: ${result.stderr || result.status}`);
  }
  return result.stdout;
}

// ------------------------------------------------------------------- helpers

async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.classList.toggle("dark", t === "dark");
    try {
      localStorage.setItem("instant-theme", t);
    } catch {}
  }, theme);
}

/** Screenshot the QR block and decode the PNG's pixels with jsqr in-page. */
async function decodeQrScreenshot(page) {
  const el = page.locator('#qr-host [role="img"]');
  await el.waitFor({ timeout: 10_000 });
  // Wait out the reveal animation so the screenshot is at full opacity.
  await page.waitForFunction(() => {
    const host = document.querySelector('#qr-host [role="img"]');
    return host && getComputedStyle(host).opacity === "1";
  });
  const png = await el.screenshot();
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = window.jsQR(data.data, canvas.width, canvas.height);
    return hit ? hit.data : null;
  }, png.toString("base64"));
}

// ---------------------------------------------------------------------- main

const browser = await chromium.launch({
  headless: !HEADED,
  args: ["--autoplay-policy=no-user-gesture-required"],
});

async function run() {
  console.log("Bundling harness with esbuild (via npx, package.json untouched)...");
  const bundle = buildHarnessBundle();

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log(`  [page error] ${error.message}`));

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  // The Next dev-tools indicator (<nextjs-portal>) floats above the page and
  // intercepts clicks aimed at harness elements; it is not part of the app.
  // It also RE-APPEARS whenever the dev server recompiles mid-run, so keep
  // zapping it rather than removing it once.
  await page.evaluate(() => {
    const zap = () => {
      for (const portal of document.querySelectorAll("nextjs-portal")) portal.remove();
    };
    zap();
    new MutationObserver(zap).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });
  await page.addScriptTag({ path: path.join(ROOT, "node_modules", "jsqr", "dist", "jsQR.js") });
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction(() => window.__harnessReady === true, undefined, { timeout: 10_000 });

  // ------------------------------------------------------------ 1. QR invite
  console.log("\n1. QR invite: decode from rendered pixels, both themes");

  for (const theme of ["light", "dark"]) {
    await setTheme(page, theme);
    await page.evaluate((url) => window.__setQrUrl(url), QR_URL);
    const decoded = await decodeQrScreenshot(page);
    check(
      `QR decodes to the exact input URL in ${theme} theme`,
      decoded === QR_URL,
      `decoded=${JSON.stringify(decoded)}`,
    );
  }

  // Regenerates when the url prop changes.
  await page.evaluate((url) => window.__setQrUrl(url), QR_URL_2);
  await page.waitForTimeout(400); // let the async re-render draw
  const redecoded = await decodeQrScreenshot(page);
  check(
    "QR regenerates when the url prop changes",
    redecoded === QR_URL_2,
    `decoded=${JSON.stringify(redecoded)}`,
  );

  const ariaLabel = await page.locator('#qr-host [role="img"]').getAttribute("aria-label");
  check(
    "QR block exposes role=img with the URL in its aria-label",
    Boolean(ariaLabel && ariaLabel.includes(QR_URL_2)),
    String(ariaLabel),
  );
  const visibleUrl = await page.locator("#qr-host p", { hasText: QR_URL_2 }).count();
  check("the URL is also visible as selectable text", visibleUrl === 1);

  await setTheme(page, "light");

  // ------------------------------------------------------- 2. sound engine
  console.log("\n2. Sound engine: offline render of every cue through the live chain");
  console.log("   (OfflineAudioContext rendering of the same scheduleCue/buildOutputChain");
  console.log("    code path the live engine plays through)");

  const cueStats = await page.evaluate(async () => {
    const { SOUND_CUES, scheduleCue, buildOutputChain } = window.__extras.sound;
    const out = [];
    for (const cue of SOUND_CUES) {
      const rate = 48000;
      const ctx = new OfflineAudioContext(2, Math.ceil(rate * 2.6), rate);
      const chain = buildOutputChain(ctx, ctx.destination, 0.12);
      const duration = scheduleCue(ctx, chain.input, cue, 0.02);
      const rendered = await ctx.startRendering();

      let peak = 0;
      let maxDiff = 0;
      let firstAbs = 0;
      let lastAbs = 0;
      let lastAudible = -1;
      for (let ch = 0; ch < rendered.numberOfChannels; ch += 1) {
        const data = rendered.getChannelData(ch);
        let prev = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = data[i];
          const a = Math.abs(v);
          if (a > peak) peak = a;
          const d = Math.abs(v - prev);
          if (d > maxDiff) maxDiff = d;
          if (a > 0.001 && i > lastAudible) lastAudible = i;
          prev = v;
        }
        firstAbs = Math.max(firstAbs, Math.abs(data[0]));
        lastAbs = Math.max(lastAbs, Math.abs(data[data.length - 1]));
      }
      out.push({
        cue,
        duration,
        tail: chain.tailSeconds,
        peak,
        maxDiff,
        firstAbs,
        lastAbs,
        lastAudibleSec: lastAudible < 0 ? 0 : lastAudible / rate,
      });
    }
    return out;
  });

  const CLICK_LIMIT = 0.05; // max sample-to-sample jump at 48 kHz; a click is a discontinuity
  console.log("\n   cue              peak     maxDiff  firstAbs  lastAbs   schedDur  audible");
  for (const s of cueStats) {
    console.log(
      `   ${s.cue.padEnd(16)} ${s.peak.toFixed(4)}   ${s.maxDiff.toFixed(4)}   ${s.firstAbs
        .toExponential(1)
        .padEnd(8)}  ${s.lastAbs.toExponential(1).padEnd(8)}  ${s.duration
        .toFixed(2)
        .padEnd(8)}  ${s.lastAudibleSec.toFixed(2)}s`,
    );
  }
  console.log("");

  for (const s of cueStats) {
    const ok =
      s.peak < 0.8 &&
      s.peak > 0.012 &&
      s.maxDiff < CLICK_LIMIT &&
      s.firstAbs < 1e-4 &&
      s.lastAbs < 1e-3 &&
      s.duration >= 0.3 &&
      s.duration <= 1.3 &&
      s.lastAudibleSec <= 0.02 + s.duration + s.tail + 0.2;
    check(
      `cue "${s.cue}" is audible, click-free, unclipped and bounded`,
      ok,
      `peak=${s.peak.toFixed(4)} maxDiff=${s.maxDiff.toFixed(4)} first=${s.firstAbs} last=${s.lastAbs} dur=${s.duration.toFixed(2)}`,
    );
  }
  // Phase 1 may add cues (knock, admit, peer-away...); every exposed cue is
  // quality-checked above, so only a shrink below the original 16 is a bug.
  check("engine exposes at least the original 16 named cues", cueStats.length >= 16, String(cueStats.length));

  console.log("\n   live engine behavior (real AudioContext, autoplay allowed)");

  // Before any user gesture: a cue request must be dropped silently.
  const preUnlock = await page.evaluate(() => {
    const { playCue, getSoundDiagnostics } = window.__extras.sound;
    playCue("noteReceived"); // must not throw
    return getSoundDiagnostics();
  });
  check(
    "a cue before the unlock gesture is dropped silently",
    preUnlock.unlocked === false && preUnlock.activeVoices === 0,
    JSON.stringify(preUnlock),
  );

  // A user gesture unlocks the context (autoplay policy is disabled by flag).
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointerdown")));
  await page.waitForFunction(
    () => window.__extras.sound.getSoundDiagnostics().unlocked === true,
    undefined,
    { timeout: 5_000 },
  );
  const postUnlock = await page.evaluate(() => window.__extras.sound.getSoundDiagnostics());
  check(
    "first gesture unlocks a running AudioContext",
    postUnlock.unlocked === true && postUnlock.contextState === "running",
    JSON.stringify(postUnlock),
  );

  // Rapid repeats collapse and the voice cap holds.
  const burst = await page.evaluate(() => {
    const { playCue, getSoundDiagnostics } = window.__extras.sound;
    for (let i = 0; i < 12; i += 1) playCue("fileReceived");
    for (let i = 0; i < 12; i += 1) playCue("noteSent");
    return getSoundDiagnostics();
  });
  check(
    "rapid repeats collapse (24 requests -> at most 2 voices)",
    burst.activeVoices > 0 && burst.activeVoices <= 2,
    `activeVoices=${burst.activeVoices}`,
  );

  // Mute persists and silences playCue entirely.
  await page.waitForFunction(
    () => window.__extras.sound.getSoundDiagnostics().activeVoices === 0,
    undefined,
    { timeout: 5_000 },
  );
  const muteProbe = await page.evaluate(() => {
    const { setMuted, playCue, getSoundDiagnostics } = window.__extras.sound;
    setMuted(true);
    playCue("peerJoined");
    const whileMuted = {
      stored: localStorage.getItem("instant-sound"),
      voices: getSoundDiagnostics().activeVoices,
    };
    setMuted(false);
    return { whileMuted, storedAfter: localStorage.getItem("instant-sound") };
  });
  check(
    "muting persists to localStorage and drops cues",
    muteProbe.whileMuted.stored === "off" && muteProbe.whileMuted.voices === 0,
    JSON.stringify(muteProbe),
  );
  check("unmuting persists too", muteProbe.storedAfter === "on", muteProbe.storedAfter);

  // The SoundToggle button mirrors and drives the same store.
  const toggle = page.locator("#sound-toggle-host button");
  check(
    "SoundToggle starts unmuted with aria-pressed=false",
    (await toggle.getAttribute("aria-pressed")) === "false",
  );
  await toggle.click();
  await page.waitForFunction(
    () => document.querySelector("#sound-toggle-host button")?.getAttribute("aria-pressed") === "true",
  );
  check(
    "clicking SoundToggle mutes and persists",
    (await page.evaluate(() => localStorage.getItem("instant-sound"))) === "off",
  );
  await toggle.click();
  await page.waitForFunction(
    () =>
      document.querySelector("#sound-toggle-host button")?.getAttribute("aria-pressed") === "false",
  );
  check(
    "clicking again unmutes",
    (await page.evaluate(() => localStorage.getItem("instant-sound"))) === "on",
  );

  // -------------------------------------------------------------- 3. toasts
  console.log("\n3. Toasts: announcement, cap, auto- and manual dismiss");

  const viewport = page.locator('[data-slot="toast-viewport"]');
  check(
    "viewport is a polite live region",
    (await viewport.getAttribute("aria-live")) === "polite" &&
      (await viewport.getAttribute("role")) === "region",
  );

  await page.evaluate(() => window.__extras.pushToast({ title: "Info toast", variant: "info" }));
  await page.locator('[data-slot="toast"][role="status"]', { hasText: "Info toast" }).waitFor();
  check("an info toast renders with role=status", true);

  await page.evaluate(() =>
    window.__extras.pushToast({ title: "Error toast", variant: "error" }),
  );
  await page.locator('[data-slot="toast"][role="alert"]', { hasText: "Error toast" }).waitFor();
  check("an error toast renders with role=alert", true);

  // Cap: flood with 7 more; the store must never report more than the cap
  // and the DOM must settle at the cap once exit animations finish.
  const storeCounts = await page.evaluate(() => {
    for (let i = 0; i < 7; i += 1) {
      window.__extras.pushToast({ title: `Flood ${i}`, durationMs: 30_000 });
    }
    const visible = window.__extras.getToasts().filter((t) => !t.leaving).length;
    return { visible, cap: window.__extras.MAX_VISIBLE_TOASTS };
  });
  check(
    `store caps visible toasts at ${storeCounts.cap}`,
    storeCounts.visible <= storeCounts.cap,
    `visible=${storeCounts.visible}`,
  );
  await page.waitForFunction(
    (cap) => document.querySelectorAll('[data-slot="toast"]').length === cap,
    storeCounts.cap,
    { timeout: 5_000 },
  );
  check("DOM settles at the cap after evictions animate out", true);

  // Auto-dismiss.
  await page.evaluate(() => {
    window.__extras.getToasts().forEach((t) => window.__extras.dismissToast(t.id));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-slot="toast"]').length === 0);
  await page.evaluate(() =>
    window.__extras.pushToast({ title: "Short lived", durationMs: 600 }),
  );
  await page.locator('[data-slot="toast"]', { hasText: "Short lived" }).waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-slot="toast"]').length === 0,
    undefined,
    { timeout: 5_000 },
  );
  check("a toast auto-dismisses after its duration", true);

  // Manual dismiss.
  await page.evaluate(() =>
    window.__extras.pushToast({ title: "Sticky until clicked", durationMs: 30_000 }),
  );
  const sticky = page.locator('[data-slot="toast"]', { hasText: "Sticky until clicked" });
  await sticky.waitFor();
  await sticky.getByRole("button", { name: /dismiss notification/i }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-slot="toast"]').length === 0,
    undefined,
    { timeout: 5_000 },
  );
  check("the dismiss button removes a toast", true);

  // --------------------------------------------------------- 4. title alert
  console.log("\n4. Title alert: unread count while hidden, exact restore on focus");

  const TITLE = "Instant - session";
  await page.evaluate((t) => {
    document.title = t;
  }, TITLE);

  // Activity while VISIBLE must not touch the title.
  await page.evaluate(() => window.__bumpActivity());
  await page.waitForTimeout(300);
  check(
    "activity while visible leaves the title alone",
    (await page.title()) === TITLE,
    await page.title(),
  );

  // Hide the tab (visibilityState is read-only, so shadow it).
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.evaluate(() => window.__bumpActivity());
  await page.evaluate(() => window.__bumpActivity());
  await page.waitForFunction((t) => document.title === `(2) ${t}`, TITLE, { timeout: 5_000 });
  check("hidden tab shows a count prefix, e.g. (2)", true);

  // Regain focus: the exact original title must come back.
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForFunction((t) => document.title === t, TITLE, { timeout: 5_000 });
  check("title restored exactly on focus", true);

  await context.close();
}

try {
  console.log(`Running extras checks against ${BASE}`);
  await run();
} catch (error) {
  failures += 1;
  console.log(`\n  ERROR  ${error.stack ?? error.message}`);
} finally {
  await browser.close();
}

console.log(failures === 0 ? "\nAll extras checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
