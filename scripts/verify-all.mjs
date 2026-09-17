/**
 * Runs every verification suite in sequence against one base URL and prints a
 * single summary table with per-suite pass/fail/skip counts. Exits non-zero
 * if any suite failed. This is the single gate for Phase 1.
 *
 *   node scripts/verify-all.mjs [baseUrl]
 *
 * Suite output is streamed through unchanged; the counts in the table are
 * parsed from the standard "  PASS  " / "  FAIL  " / "  SKIP  " lines every
 * suite in this directory prints. Keep this file ASCII-only.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.argv.slice(2).find((arg) => arg.startsWith("http")) ?? "http://127.0.0.1:3111";

/** Execution order: fast HTTP checks first, the browser suites after. */
const SUITES = [
  "verify-mesh-signalling.mjs", // wire contract: knock/admit, capacity, resume, authority
  "verify-ice-race.mjs", //         candidate-before-SDP race, per mesh link
  "verify-sdp-drop.mjs", //         lost-SDP watchdog: re-offer, then rebuild the link
  "verify-mesh-e2e.mjs", //         3-up and 5-up rooms plus a mobile pass
  "verify-mesh-resume.mjs", //      reload a guest and the host mid-session
  "verify-e2e.mjs", //              deep 2-person features: notes, files, media, close
  "verify-recreate.mjs", //         recreate-after-close regression
  "verify-scan.mjs", //             QR camera-scan join path
  "verify-extras.mjs", //           QR invite, sound engine, toasts, title alert
  "verify-download-tiers.mjs", //   folder / service-worker / memory sinks, pickers
  "verify-transfer-resume.mjs", //  per-recipient targeting and resumable transfers
  "verify-video-grid.mjs", //       stage+strip layout, pinning, host moderation
  "verify-audio-playback.mjs", //   remote audio is audible, not merely delivered
  "verify-host-handover.mjs", //     clean close without a false error; host transfer
  "verify-end-session.mjs", //       close-for-everyone vs leave-with-successor
  "verify-visibility.mjs", //        public vs private rooms, short and custom codes
];

const COUNT_LINE = /^\s{2}(PASS|FAIL|SKIP)\s{2}/;

function runSuite(file) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const counts = { pass: 0, fail: 0, skip: 0 };
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, file), BASE], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffer = "";
    const consume = (chunk) => {
      process.stdout.write(chunk);
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        const hit = COUNT_LINE.exec(line);
        if (hit) counts[hit[1].toLowerCase()] += 1;
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);

    child.on("close", (code) => {
      resolve({
        file,
        code: code ?? 1,
        counts,
        seconds: Math.round((Date.now() - startedAt) / 1000),
      });
    });
    child.on("error", (error) => {
      console.log(`  ERROR  could not start ${file}: ${error.message}`);
      resolve({ file, code: 1, counts, seconds: 0 });
    });
  });
}

console.log(`Running every verification suite against ${BASE}\n`);

const results = [];
for (const file of SUITES) {
  console.log(`${"=".repeat(74)}\n== ${file}\n${"=".repeat(74)}`);
  results.push(await runSuite(file));
  console.log("");
}

// ------------------------------------------------------------------ summary
const name = (r) => r.file.replace(/\.mjs$/, "");
const width = Math.max(...results.map((r) => name(r).length)) + 2;
const pad = (value, n) => String(value).padStart(n);

console.log("=".repeat(74));
console.log("SUMMARY");
console.log("=".repeat(74));
console.log(`${"suite".padEnd(width)}${pad("pass", 6)}${pad("fail", 6)}${pad("skip", 6)}${pad("time", 7)}  result`);
console.log("-".repeat(width + 33));
for (const r of results) {
  const verdict = r.code === 0 ? "OK" : "FAILED";
  console.log(
    `${name(r).padEnd(width)}${pad(r.counts.pass, 6)}${pad(r.counts.fail, 6)}${pad(r.counts.skip, 6)}${pad(`${r.seconds}s`, 7)}  ${verdict}`,
  );
}
console.log("-".repeat(width + 33));
const total = results.reduce(
  (acc, r) => ({
    pass: acc.pass + r.counts.pass,
    fail: acc.fail + r.counts.fail,
    skip: acc.skip + r.counts.skip,
  }),
  { pass: 0, fail: 0, skip: 0 },
);
const failedSuites = results.filter((r) => r.code !== 0);
console.log(
  `${"TOTAL".padEnd(width)}${pad(total.pass, 6)}${pad(total.fail, 6)}${pad(total.skip, 6)}${pad("", 7)}  ${failedSuites.length === 0 ? "OK" : `${failedSuites.length} suite(s) failed`}`,
);

process.exit(failedSuites.length === 0 ? 0 : 1);
