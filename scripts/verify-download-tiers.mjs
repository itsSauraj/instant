/**
 * Verification suite for the Phase 2 download-sink lane:
 *   lib/download-sink.ts, lib/download-sw-client.ts,
 *   public/instant-download-sw.js, components/room/files-panel.tsx,
 *   components/room/recipient-picker.tsx, components/room/destination-picker.tsx
 *
 * Proves, with real Chromium runs against the dev server:
 *   1. The peer-supplied-filename sanitiser (traversal, devices, length, ctrl).
 *   2. The memory tier: byte-for-byte integrity (SHA-256), per-file and
 *      session caps, zero-byte files, abort releasing budget.
 *   3. The filesystem tier's full logic against a scripted directory handle
 *      (collision de-dup, hostile names, resume seek, abort cleanup,
 *      permission re-check) -- the REAL picker dialog cannot be driven
 *      headlessly, which is SKIPped explicitly.
 *   4. The Service Worker tier end to end: lazy registration on the narrow
 *      /instant-download/ scope, a REAL download whose saved file matches the
 *      source checksum, app requests untouched, 404 for unknown tokens, and
 *      visible failure when the download is cancelled mid-stream.
 *   5. The recipient picker's selection semantics (real component, mounted
 *      via its dev harness until the manager wires room-client).
 *   6. The destination picker's honesty in each capability state.
 *   7. A real two-person room transfer through the rewritten files panel
 *      (current engine = memory path), checksum-verified on the receiver.
 *
 * Keep this file ASCII-only.
 *
 * Usage: node scripts/verify-download-tiers.mjs [baseUrl] [--headed]
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createRoomAsHost,
  knockAndAdmit,
  launchMeshBrowser,
  makeChecker,
  newParticipant,
  parseCliArgs,
  shot,
  wait,
  waitForConnected,
} from "./mesh-shared.mjs";

const { base, headed } = parseCliArgs();
const { state, check, skip } = makeChecker();

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** The dev-only module handle set by lib/download-sink.ts on room pages. */
async function waitForSinkHandle(page, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const present = await page
      .evaluate(() => Boolean(window.__instantDownloadSink))
      .catch(() => false);
    if (present) return true;
    if (Date.now() > deadline) return false;
    await wait(300);
  }
}

/** A host alone in the room sits under the LobbyOverlay; close it first. */
async function dismissLobbyOverlay(page) {
  const dismiss = page.getByRole("button", { name: /close and wait in the room/i }).first();
  for (let i = 0; i < 10; i += 1) {
    if (!(await dismiss.isVisible().catch(() => false))) return true;
    await dismiss.click({ timeout: 2000 }).catch(() => {});
    await wait(300);
  }
  return !(await dismiss.isVisible().catch(() => false));
}

async function openFilesTab(page) {
  await dismissLobbyOverlay(page);
  const tab = page.getByRole("tab", { name: /files/i }).first();
  for (let i = 0; i < 10; i += 1) {
    await tab.click({ timeout: 2000 }).catch(() => {});
    const selected = await tab.getAttribute("aria-selected").catch(() => null);
    if (selected === "true") return true;
    await wait(300);
  }
  return false;
}

/** Init script: hide Service Workers AND the directory picker entirely. */
const NO_SW_NO_FS_INIT = () => {
  try {
    Object.defineProperty(Navigator.prototype, "serviceWorker", {
      get: () => undefined,
      configurable: true,
    });
  } catch (error) {
    /* already gone */
  }
  try {
    delete Window.prototype.showDirectoryPicker;
  } catch (error) {
    /* not on the prototype */
  }
  try {
    Object.defineProperty(window, "showDirectoryPicker", {
      value: undefined,
      configurable: true,
    });
  } catch (error) {
    /* leave whatever is there */
  }
};

/**
 * Init script: replace showDirectoryPicker with a scripted directory handle
 * so the filesystem sink's logic runs for real without the (undriveable)
 * native dialog. Files live in window.__fakeFs.files as Uint8Arrays.
 */
const FAKE_FS_INIT = () => {
  const files = new Map();
  window.__fakeFs = {
    files,
    denyPermission: false,
    read: (name) => {
      const bytes = files.get(name);
      return bytes ? Array.from(bytes) : null;
    },
    list: () => Array.from(files.keys()),
    seed: (name, values) => {
      files.set(name, new Uint8Array(values));
    },
  };
  const dir = {
    name: "FakeFolder",
    queryPermission: async () => (window.__fakeFs.denyPermission ? "denied" : "granted"),
    requestPermission: async () => (window.__fakeFs.denyPermission ? "denied" : "granted"),
    getFileHandle: async (name, opts) => {
      if (!files.has(name)) {
        if (!opts || !opts.create) throw new DOMException("not found", "NotFoundError");
        files.set(name, new Uint8Array(0));
      }
      return {
        name,
        createWritable: async (options) => {
          let buf =
            options && options.keepExistingData ? files.get(name).slice() : new Uint8Array(0);
          let pos = 0;
          return {
            seek: async (offset) => {
              pos = offset;
            },
            write: async (chunk) => {
              const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
              const end = pos + data.length;
              if (end > buf.length) {
                const grown = new Uint8Array(end);
                grown.set(buf);
                buf = grown;
              }
              buf.set(data, pos);
              pos = end;
            },
            close: async () => {
              files.set(name, buf);
            },
            abort: async () => {},
          };
        },
      };
    },
    removeEntry: async (name) => {
      files.delete(name);
    },
  };
  Object.defineProperty(window, "showDirectoryPicker", {
    configurable: true,
    value: async () => {
      window.__pickerCalls = (window.__pickerCalls || 0) + 1;
      return dir;
    },
  });
};

async function main() {
  console.log(`verify-download-tiers against ${base}`);
  const browser = await launchMeshBrowser({ headed });
  const workDir = await mkdtemp(path.join(tmpdir(), "instant-tiers-"));

  try {
    // =====================================================================
    console.log("\n[1] Filename sanitiser (hostile peer-supplied names)");
    // =====================================================================
    const ctxA = await newParticipant(browser, "host-a", { name: "TierHost" });
    const roomUrl = await createRoomAsHost(ctxA, base);
    check("room created for sink tests", /\/room\//.test(roomUrl), roomUrl);
    check("dev sink handle present", await waitForSinkHandle(ctxA.page));

    const sanitiserCases = [
      { input: "../../etc/passwd", expect: "passwd" },
      { input: "..\\..\\Windows\\System32\\drivers\\etc\\hosts", expect: "hosts" },
      { input: "CON.txt", expect: "_CON.txt" },
      { input: "lpt5.log", expect: "_lpt5.log" },
      { input: "com9", expect: "_com9" },
      { input: "...", expect: "download" },
      { input: ".hidden", expect: "hidden" },
      { input: "trailing. ", expect: "trailing" },
      { input: "", expect: "download" },
      { input: 'a<b>c:d"e|f?g*h.txt', expect: "a_b_c_d_e_f_g_h.txt" },
    ];
    const sanitised = await ctxA.page.evaluate(
      (cases) => cases.map((c) => window.__instantDownloadSink.sanitizeFileName(c.input)),
      sanitiserCases,
    );
    sanitiserCases.forEach((c, i) => {
      check(
        `sanitise ${JSON.stringify(c.input)} -> ${JSON.stringify(c.expect)}`,
        sanitised[i] === c.expect,
        `got ${JSON.stringify(sanitised[i])}`,
      );
    });
    const special = await ctxA.page.evaluate(() => {
      const s = window.__instantDownloadSink.sanitizeFileName;
      return {
        long: s("a".repeat(300) + ".txt"),
        ctrl: s("bad namefile.txt"),
        nonString: s(42),
      };
    });
    check(
      "300-char name capped with extension kept",
      special.long.length <= 150 && special.long.endsWith(".txt"),
      `len ${special.long.length}`,
    );
    check(
      "control characters removed",
      special.ctrl === "badnamefile.txt",
      JSON.stringify(special.ctrl),
    );
    check('non-string name -> "download"', special.nonString === "download");

    // =====================================================================
    console.log("\n[2] Memory tier (Service Worker and FS Access absent)");
    // =====================================================================
    const ctxB = await newParticipant(browser, "host-b", { name: "MemHost" });
    await ctxB.context.addInitScript(NO_SW_NO_FS_INIT);
    await createRoomAsHost(ctxB, base);
    check("dev sink handle present (no-SW context)", await waitForSinkHandle(ctxB.page));

    const memCapability = await ctxB.page.evaluate(() => {
      const provider = window.__instantDownloadSink.getDefaultSinkProvider();
      return { capability: provider.capability(), canChoose: provider.canChooseFolder() };
    });
    check(
      'capability degrades to tier "memory" with a real cap',
      memCapability.capability.tier === "memory" &&
        memCapability.capability.streaming === false &&
        typeof memCapability.capability.maxBytes === "number" &&
        memCapability.capability.maxBytes > 0,
      JSON.stringify(memCapability.capability),
    );
    check("canChooseFolder() is false without the API", memCapability.canChoose === false);
    check(
      "memory capability claims no destination",
      memCapability.capability.hasDestination === false &&
        memCapability.capability.destinationLabel === null,
    );

    check("files tab opens (no-SW context)", await openFilesTab(ctxB.page));
    const memPickerText = await ctxB.page
      .locator('[data-slot="destination-picker"]')
      .innerText()
      .catch(() => "");
    check(
      "destination picker explains the memory limit",
      /held in memory/i.test(memPickerText) && /up to .+ per file/i.test(memPickerText),
      JSON.stringify(memPickerText),
    );
    check(
      "destination picker offers no folder button without the API",
      !/choose a folder/i.test(memPickerText),
    );
    check(
      "destination picker never claims a folder was chosen",
      !/stream straight into/i.test(memPickerText),
    );
    await shot(ctxB.page, "tiers-memory-destination.png");

    const memResult = await ctxB.page.evaluate(async () => {
      const { createSinkProvider } = window.__instantDownloadSink;
      const provider = createSinkProvider();
      const size = 256 * 1024 + 13;
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 65536) {
        crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, size)));
      }
      const hex = (buffer) =>
        [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const sourceDigest = hex(await crypto.subtle.digest("SHA-256", bytes));

      const sink = await provider.open({
        name: "mem.bin",
        mime: "application/octet-stream",
        expectedBytes: size,
        transferId: "t-mem-1",
      });
      const tier = sink.tier;
      // Uneven chunks on purpose: order and boundaries must not matter.
      const cuts = [0, 70_000, 70_001, 200_000, size];
      for (let i = 0; i + 1 < cuts.length; i += 1) {
        await sink.write(bytes.subarray(cuts[i], cuts[i + 1]));
      }
      const written = sink.written;
      const { url } = await sink.close();
      const blob = window.__blobRegistry ? window.__blobRegistry.get(url) : null;
      const savedDigest = blob ? hex(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())) : null;

      // Zero-byte file must still complete.
      const zero = await provider.open({
        name: "empty.bin",
        mime: "text/plain",
        expectedBytes: 0,
        transferId: "t-mem-0",
      });
      const zeroUrl = (await zero.close()).url;
      const zeroBlob = window.__blobRegistry ? window.__blobRegistry.get(zeroUrl) : null;

      return {
        tier,
        written,
        size,
        urlOk: typeof url === "string" && url.startsWith("blob:"),
        match: savedDigest === sourceDigest,
        blobSize: blob ? blob.size : -1,
        zeroOk: Boolean(zeroUrl) && zeroBlob !== null && zeroBlob.size === 0,
      };
    });
    check('open() fell back to the "memory" sink', memResult.tier === "memory");
    check("memory sink returns a blob: URL from close()", memResult.urlOk);
    check(
      "memory tier is byte-for-byte intact (SHA-256 match)",
      memResult.match && memResult.blobSize === memResult.size,
      JSON.stringify(memResult),
    );
    check("sink.written is exact", memResult.written === memResult.size);
    check("zero-byte file completes with an empty blob", memResult.zeroOk);

    const capsResult = await ctxB.page.evaluate(async () => {
      const { createSinkProvider } = window.__instantDownloadSink;
      const provider = createSinkProvider({
        limits: { maxMemoryBytes: 1000, maxSessionMemoryBytes: 1500 },
      });
      const tryOpen = async (expectedBytes, transferId) => {
        try {
          return {
            sink: await provider.open({
              name: "cap.bin",
              mime: "",
              expectedBytes,
              transferId,
            }),
            error: null,
          };
        } catch (error) {
          return { sink: null, error: String((error && error.message) || error) };
        }
      };

      const perFile = await tryOpen(1200, "cap-a"); // > 1000: refuse up front
      const first = await tryOpen(700, "cap-b");
      const second = await tryOpen(700, "cap-c"); // 1400 <= 1500: fine
      const budget = await tryOpen(200, "cap-d"); // 1600 > 1500: refuse
      if (second.sink) await second.sink.abort(); // releases 700
      const afterAbort = await tryOpen(200, "cap-e"); // 900: fine again

      // Overflow past the declared size is re-accounted per byte.
      const overflow = await tryOpen(100, "cap-f"); // held now 1000
      let overflowError = null;
      if (overflow.sink) {
        try {
          await overflow.sink.write(new Uint8Array(600)); // 600 > 100: reserve more (total 1500)
          await overflow.sink.write(new Uint8Array(600)); // 1200 > per-file 1000: must throw
        } catch (error) {
          overflowError = String((error && error.message) || error);
        }
      }
      return {
        perFileRefused: perFile.error,
        firstOk: Boolean(first.sink),
        secondOk: Boolean(second.sink),
        budgetRefused: budget.error,
        afterAbortOk: Boolean(afterAbort.sink),
        overflowError,
      };
    });
    check(
      "per-file memory cap refuses up front",
      typeof capsResult.perFileRefused === "string" && /limit/i.test(capsResult.perFileRefused),
      JSON.stringify(capsResult.perFileRefused),
    );
    check("openings within budget succeed", capsResult.firstOk && capsResult.secondOk);
    check(
      "session memory budget refuses the file that would exceed it",
      typeof capsResult.budgetRefused === "string" && /budget/i.test(capsResult.budgetRefused),
      JSON.stringify(capsResult.budgetRefused),
    );
    check("abort() returns its reservation to the budget", capsResult.afterAbortOk);
    check(
      "writing past the per-file cap fails mid-transfer",
      typeof capsResult.overflowError === "string" && /limit/i.test(capsResult.overflowError),
      JSON.stringify(capsResult.overflowError),
    );
    await ctxB.context.close();

    // =====================================================================
    console.log("\n[3] Filesystem tier against a scripted directory handle");
    // =====================================================================
    const ctxC = await newParticipant(browser, "host-c", { name: "FsHost" });
    await ctxC.context.addInitScript(FAKE_FS_INIT);
    await createRoomAsHost(ctxC, base);
    check("dev sink handle present (fake-FS context)", await waitForSinkHandle(ctxC.page));
    check("files tab opens (fake-FS context)", await openFilesTab(ctxC.page));

    const preChoose = await ctxC.page.evaluate(() => {
      const provider = window.__instantDownloadSink.getDefaultSinkProvider();
      return { capability: provider.capability(), canChoose: provider.canChooseFolder() };
    });
    check("canChooseFolder() true when the API exists", preChoose.canChoose === true);
    check(
      'capability is "download" before any folder is chosen',
      preChoose.capability.tier === "download" && preChoose.capability.hasDestination === false,
      JSON.stringify(preChoose.capability),
    );

    const destPicker = ctxC.page.locator('[data-slot="destination-picker"]');
    const beforeText = await destPicker.innerText().catch(() => "");
    check(
      "destination picker offers the folder button but claims nothing yet",
      /choose a folder/i.test(beforeText) && !/stream straight into/i.test(beforeText),
      JSON.stringify(beforeText),
    );

    // A real click = a real user gesture into chooseFolder().
    await ctxC.page.getByRole("button", { name: /choose a folder/i }).click();
    await wait(400);
    const afterText = await destPicker.innerText().catch(() => "");
    check(
      "after choosing, the picker names the folder",
      /stream straight into/i.test(afterText) && /FakeFolder/.test(afterText),
      JSON.stringify(afterText),
    );
    const chosenCapability = await ctxC.page.evaluate(() =>
      window.__instantDownloadSink.getDefaultSinkProvider().capability(),
    );
    check(
      'capability is now "filesystem" with the folder label',
      chosenCapability.tier === "filesystem" &&
        chosenCapability.hasDestination === true &&
        chosenCapability.destinationLabel === "FakeFolder",
      JSON.stringify(chosenCapability),
    );
    await shot(ctxC.page, "tiers-folder-chosen.png");

    const fsResult = await ctxC.page.evaluate(async () => {
      const { createSinkProvider } = window.__instantDownloadSink;
      const provider = createSinkProvider();
      await provider.chooseFolder();
      const fs = window.__fakeFs;
      const out = {};

      // Plain write, byte-for-byte.
      const source = Array.from({ length: 5000 }, (_, i) => i % 251);
      const sink1 = await provider.open({
        name: "report.pdf",
        mime: "application/pdf",
        expectedBytes: source.length,
        transferId: "fs-1",
      });
      out.tier = sink1.tier;
      out.savedAs1 = sink1.savedAs;
      await sink1.write(new Uint8Array(source.slice(0, 1234)));
      await sink1.write(new Uint8Array(source.slice(1234)));
      const closed = await sink1.close();
      out.urlIsNull = closed.url === null;
      const onDisk = fs.read("report.pdf");
      out.bytesMatch =
        onDisk !== null &&
        onDisk.length === source.length &&
        onDisk.every((b, i) => b === source[i]);

      // Collision: never overwrite; de-duplicate instead.
      const sink2 = await provider.open({
        name: "report.pdf",
        mime: "application/pdf",
        expectedBytes: 3,
        transferId: "fs-2",
      });
      out.savedAs2 = sink2.savedAs;
      await sink2.write(new Uint8Array([1, 2, 3]));
      await sink2.close();
      out.originalUntouched =
        fs.read("report.pdf").length === source.length && fs.read("report (2).pdf") !== null;

      // Hostile names go through the sanitiser before touching the handle.
      const sink3 = await provider.open({
        name: "../../etc/passwd",
        mime: "",
        expectedBytes: 2,
        transferId: "fs-3",
      });
      out.savedAs3 = sink3.savedAs;
      await sink3.write(new Uint8Array([7, 7]));
      await sink3.close();
      const sink4 = await provider.open({
        name: "CON.txt",
        mime: "",
        expectedBytes: 1,
        transferId: "fs-4",
      });
      out.savedAs4 = sink4.savedAs;
      await sink4.abort(); // and abort must remove the partial
      out.conRemoved = fs.read("_CON.txt") === null;

      // Resume: reopen the SAME file, seek, keep existing data.
      const sinkR = await provider.open({
        name: "resume.bin",
        mime: "",
        expectedBytes: 6,
        transferId: "fs-r",
      });
      await sinkR.write(new Uint8Array([1, 2, 3, 4, 5, 6]));
      await sinkR.close();
      const sinkR2 = await provider.open({
        name: "resume.bin",
        mime: "",
        expectedBytes: 6,
        transferId: "fs-r",
        resumeFrom: 3,
      });
      out.resumeWrittenStartsAtOffset = sinkR2.written === 3;
      out.resumeReusedName = sinkR2.savedAs === "resume.bin";
      await sinkR2.write(new Uint8Array([9, 9, 9]));
      await sinkR2.close();
      const resumed = fs.read("resume.bin");
      out.resumedBytes = resumed;

      // Permission loss: re-checked per file; resume must NOT hop tiers.
      fs.denyPermission = true;
      let resumeDeniedError = null;
      try {
        await provider.open({
          name: "resume.bin",
          mime: "",
          expectedBytes: 6,
          transferId: "fs-r",
          resumeFrom: 3,
        });
      } catch (error) {
        resumeDeniedError = String((error && error.message) || error);
      }
      out.resumeDeniedError = resumeDeniedError;
      fs.denyPermission = false;

      // clearFolder(): resume with no folder must throw, not restart elsewhere.
      provider.clearFolder();
      let resumeNoFolderError = null;
      try {
        await provider.open({
          name: "resume.bin",
          mime: "",
          expectedBytes: 6,
          transferId: "fs-r",
          resumeFrom: 3,
        });
      } catch (error) {
        resumeNoFolderError = String((error && error.message) || error);
      }
      out.resumeNoFolderError = resumeNoFolderError;

      out.files = fs.list();
      return out;
    });
    check('filesystem sink reports tier "filesystem"', fsResult.tier === "filesystem");
    check("filesystem close() returns url: null", fsResult.urlIsNull === true);
    check(
      "filesystem write is byte-for-byte intact",
      fsResult.bytesMatch === true,
      JSON.stringify(fsResult.files),
    );
    check(
      'collision de-duplicates to "report (2).pdf" without overwriting',
      fsResult.savedAs1 === "report.pdf" &&
        fsResult.savedAs2 === "report (2).pdf" &&
        fsResult.originalUntouched === true,
      `savedAs2=${fsResult.savedAs2}`,
    );
    check(
      '"../../etc/passwd" lands as plain "passwd" inside the folder',
      fsResult.savedAs3 === "passwd" && fsResult.files.includes("passwd"),
      `savedAs3=${fsResult.savedAs3}`,
    );
    check(
      '"CON.txt" is de-reserved to "_CON.txt"',
      fsResult.savedAs4 === "_CON.txt",
      `savedAs4=${fsResult.savedAs4}`,
    );
    check("abort() removes the partial file", fsResult.conRemoved === true);
    check(
      "resume reopens the SAME file at the offset (written starts there)",
      fsResult.resumeWrittenStartsAtOffset === true && fsResult.resumeReusedName === true,
    );
    check(
      "resumed file = kept prefix + new bytes",
      JSON.stringify(fsResult.resumedBytes) === JSON.stringify([1, 2, 3, 9, 9, 9]),
      JSON.stringify(fsResult.resumedBytes),
    );
    check(
      "permission loss fails a resume instead of hopping tiers",
      typeof fsResult.resumeDeniedError === "string",
      String(fsResult.resumeDeniedError),
    );
    check(
      "resume with the folder cleared throws a clear error",
      typeof fsResult.resumeNoFolderError === "string" &&
        /folder/i.test(fsResult.resumeNoFolderError),
      String(fsResult.resumeNoFolderError),
    );

    // Clearing via the UI must drop every folder claim.
    await ctxC.page.getByRole("button", { name: /stop saving into this folder/i }).click();
    await wait(300);
    const clearedText = await destPicker.innerText().catch(() => "");
    check(
      "clearing the folder returns the picker to the downloads-folder copy",
      !/FakeFolder/.test(clearedText) && /downloads folder/i.test(clearedText),
      JSON.stringify(clearedText),
    );
    await ctxC.context.close();

    skip(
      "real showDirectoryPicker dialog + real disk writes",
      "the native chooser cannot be driven from headless Playwright; the sink logic runs against a scripted handle instead, and feature detection/fallback is asserted directly",
    );

    // =====================================================================
    console.log("\n[4] Service Worker tier (real registration, real download)");
    // =====================================================================
    const regsBefore = await ctxA.page.evaluate(async () =>
      navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : -1,
    );
    check("worker is NOT registered before the tier is first used", regsBefore === 0, String(regsBefore));

    const swCapability = await ctxA.page.evaluate(() =>
      window.__instantDownloadSink.getDefaultSinkProvider().capability(),
    );
    check(
      'capability is streaming tier "download" with no folder chosen',
      swCapability.tier === "download" &&
        swCapability.streaming === true &&
        swCapability.maxBytes === null,
      JSON.stringify(swCapability),
    );

    const downloadPromise = ctxA.page.waitForEvent("download", { timeout: 45_000 });
    const swSend = await ctxA.page.evaluate(async () => {
      const { createSinkProvider } = window.__instantDownloadSink;
      const provider = createSinkProvider();
      const size = 3 * 1024 * 1024 + 12_345;
      const bytes = new Uint8Array(size);
      for (let i = 0; i < size; i += 65536) {
        crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, size)));
      }
      const hex = (buffer) =>
        [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
      const sink = await provider.open({
        name: "sw-proof.bin",
        mime: "application/octet-stream",
        expectedBytes: size,
        transferId: "sw-1",
      });
      const tier = sink.tier;
      const step = 64 * 1024;
      for (let offset = 0; offset < size; offset += step) {
        await sink.write(bytes.subarray(offset, Math.min(offset + step, size)));
      }
      await sink.close();
      return { tier, digest, size, written: sink.written };
    });
    check('open() picked the "download" sink', swSend.tier === "download");
    check("sink.written is exact for the streamed file", swSend.written === swSend.size);

    const download = await downloadPromise;
    check(
      "a real download was triggered with the sanitised filename",
      download.suggestedFilename() === "sw-proof.bin",
      download.suggestedFilename(),
    );
    const downloadPath = await download.path();
    const savedBytes = await readFile(downloadPath);
    check(
      "download-manager file is byte-for-byte intact (SHA-256 match)",
      savedBytes.length === swSend.size && sha256(savedBytes) === swSend.digest,
      `saved ${savedBytes.length} of ${swSend.size} bytes`,
    );

    const swState = await ctxA.page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations();
      const appFetch = await fetch("/", { cache: "no-store" });
      return {
        scopes: regs.map((r) => r.scope),
        controlled: navigator.serviceWorker.controller !== null,
        appStatus: appFetch.status,
        appType: appFetch.headers.get("content-type") || "",
      };
    });
    check(
      "exactly one registration, scoped to /instant-download/ only",
      swState.scopes.length === 1 && swState.scopes[0].endsWith("/instant-download/"),
      JSON.stringify(swState.scopes),
    );
    check("the app page itself is NOT controlled by the worker", swState.controlled === false);
    check(
      "app requests pass through untouched (fetch / still serves HTML 200)",
      swState.appStatus === 200 && /text\/html/.test(swState.appType),
      `${swState.appStatus} ${swState.appType}`,
    );

    const unknownTokenText = await ctxA.page.evaluate(async () => {
      const frame = document.createElement("iframe");
      frame.src = "/instant-download/no-such-token/x.bin";
      document.body.appendChild(frame);
      await new Promise((resolve) => {
        frame.onload = resolve;
        setTimeout(resolve, 5000);
      });
      const text = frame.contentDocument ? frame.contentDocument.body.textContent : "";
      frame.remove();
      return text || "";
    });
    check(
      "unknown synthetic token gets the worker's own 404, not the app's",
      /download not found/i.test(unknownTokenText),
      JSON.stringify(unknownTokenText.slice(0, 80)),
    );

    // Cancel mid-download: pending/future writes must fail loudly, not hang.
    const cancelDownloadPromise = ctxA.page.waitForEvent("download", { timeout: 45_000 });
    await ctxA.page.evaluate(() => {
      const { createSinkProvider } = window.__instantDownloadSink;
      const provider = createSinkProvider();
      window.__cancelOutcome = null;
      window.__cancelTier = null;
      window.__cancelRun = (async () => {
        const size = 512 * 1024 * 1024; // never finishes; cancellation ends it
        const chunk = new Uint8Array(64 * 1024);
        try {
          const sink = await provider.open({
            name: "sw-cancel.bin",
            mime: "application/octet-stream",
            expectedBytes: size,
            transferId: "sw-2",
          });
          window.__cancelTier = sink.tier;
          for (let offset = 0; offset < size; offset += chunk.length) {
            await sink.write(chunk);
          }
          window.__cancelOutcome = "completed";
        } catch (error) {
          window.__cancelOutcome = `rejected: ${String((error && error.message) || error)}`;
        }
      })();
    });
    const cancelDownload = await cancelDownloadPromise;
    await wait(500); // let some writes flow first
    await cancelDownload.cancel();
    let cancelOutcome = null;
    for (let i = 0; i < 60; i += 1) {
      cancelOutcome = await ctxA.page.evaluate(() => window.__cancelOutcome);
      if (cancelOutcome) break;
      await wait(500);
    }
    const cancelTier = await ctxA.page.evaluate(() => window.__cancelTier);
    check(
      'the second download also went through the "download" tier',
      cancelTier === "download",
      String(cancelTier),
    );
    check(
      "cancelling the download makes write() reject instead of hanging",
      typeof cancelOutcome === "string" && cancelOutcome.startsWith("rejected:"),
      String(cancelOutcome),
    );

    skip(
      "Content-Disposition header string asserted directly",
      "download navigations do not surface their response headers to Playwright; proven behaviourally instead (attachment semantics = the download event, filename = suggestedFilename, body = checksum of the saved file)",
    );
    skip(
      "service worker killed mid-download by the browser",
      "Playwright has no API to terminate a service worker process; the same client-visible failure path (response stream cancelled -> write() rejects) is exercised via download.cancel()",
    );

    // =====================================================================
    console.log("\n[5] Recipient picker semantics (real component, dev mount)");
    // =====================================================================
    const PEERS = [
      { id: "p1", name: "Ada", isHost: false, joinedAt: 1, away: false, connectionState: "connected" },
      { id: "p2", name: "Grace", isHost: false, joinedAt: 2, away: false, connectionState: "connected" },
      { id: "p3", name: "Alan", isHost: false, joinedAt: 3, away: false, connectionState: "connecting" },
      { id: "p4", name: "Edsger", isHost: false, joinedAt: 4, away: true, connectionState: "closed" },
    ];
    await dismissLobbyOverlay(ctxA.page); // clicks below must reach the harness
    const harnessReady = await ctxA.page.evaluate((peers) => {
      if (!window.__instantRecipientPickerTest) return false;
      const el = document.createElement("div");
      el.id = "picker-test";
      document.body.appendChild(el);
      window.__pickerUnmount = window.__instantRecipientPickerTest.mount(el, peers);
      return true;
    }, PEERS);
    check("picker dev harness mounts", harnessReady === true);

    const pickerRoot = ctxA.page.locator("#picker-test");
    const picker = pickerRoot.locator('[data-slot="recipient-picker"]');
    const selection = pickerRoot.locator('[data-slot="recipient-picker-selection"]');
    await picker.waitFor({ timeout: 10_000 });

    check(
      'default selection is "everyone"',
      (await selection.innerText()).trim() === "everyone",
      await selection.innerText(),
    );

    const selectAll = pickerRoot.getByLabel(/select all/i);
    const selectAllState = await selectAll.evaluate((el) => ({
      checked: el.checked,
      indeterminate: el.indeterminate,
    }));
    check(
      "select-all starts checked, not indeterminate",
      selectAllState.checked === true && selectAllState.indeterminate === false,
      JSON.stringify(selectAllState),
    );

    const adaBox = pickerRoot.getByRole("checkbox", { name: /^Ada$/ });
    const alanBox = pickerRoot.getByRole("checkbox", { name: /Alan/ });
    const edsgerBox = pickerRoot.getByRole("checkbox", { name: /Edsger/ });
    check("connected peers are enabled", (await adaBox.isEnabled()) === true);
    check(
      "a not-connected peer is disabled and says why",
      (await alanBox.isDisabled()) === true &&
        /\(not connected\)/i.test(await picker.innerText()),
    );
    check(
      "an away peer is disabled with a reconnecting reason",
      (await edsgerBox.isDisabled()) === true &&
        /\(reconnecting\)/i.test(await picker.innerText()),
    );

    await adaBox.uncheck();
    check(
      "unchecking one peer produces an explicit list of the rest",
      (await selection.innerText()).trim() === JSON.stringify(["p2"]),
      await selection.innerText(),
    );
    const midState = await selectAll.evaluate((el) => ({
      checked: el.checked,
      indeterminate: el.indeterminate,
    }));
    check(
      "select-all becomes indeterminate for a partial selection",
      midState.checked === false && midState.indeterminate === true,
      JSON.stringify(midState),
    );

    await adaBox.check();
    check(
      're-checking everyone collapses back to "everyone" (future joiners included)',
      (await selection.innerText()).trim() === "everyone",
      await selection.innerText(),
    );

    await selectAll.uncheck();
    const noneState = await selectAll.evaluate((el) => ({
      checked: el.checked,
      indeterminate: el.indeterminate,
    }));
    check(
      "unchecking select-all selects nobody (explicit empty list)",
      (await selection.innerText()).trim() === "[]" &&
        noneState.checked === false &&
        noneState.indeterminate === false,
      await selection.innerText(),
    );
    await selectAll.check();
    check(
      'select-all restores "everyone"',
      (await selection.innerText()).trim() === "everyone",
    );
    await shot(ctxA.page, "tiers-recipient-picker.png");

    const singlePeerHidden = await ctxA.page.evaluate((peers) => {
      window.__pickerUnmount();
      const el = document.getElementById("picker-test");
      window.__pickerUnmount = window.__instantRecipientPickerTest.mount(el, peers.slice(0, 1));
      return true;
    }, PEERS);
    check("harness remounts with one participant", singlePeerHidden === true);
    await wait(300);
    check(
      "picker does not render at all with only one other person",
      (await picker.count()) === 0 || !(await picker.isVisible().catch(() => false)),
    );
    await ctxA.page.evaluate(() => {
      window.__pickerUnmount();
      document.getElementById("picker-test").remove();
    });

    // =====================================================================
    console.log("\n[6] Real room: two people, panel send, receiver checksum");
    // =====================================================================
    const guest = await newParticipant(browser, "guest", { name: "TierGuest" });
    await knockAndAdmit(ctxA, guest, roomUrl);
    await waitForConnected(ctxA.page, { peers: 1 });
    await waitForConnected(guest.page, { peers: 1 });

    check("files tab opens on the host", await openFilesTab(ctxA.page));
    check("files tab opens on the guest", await openFilesTab(guest.page));

    check(
      "recipient picker absent in the live panel with one peer",
      (await ctxA.page
        .locator('.panel [data-slot="recipient-picker"]')
        .count()) === 0,
    );
    check(
      "destination picker present in the live panel",
      (await ctxA.page.locator('[data-slot="destination-picker"]').count()) > 0,
    );

    const payload = randomBytes(300_000);
    const payloadDigest = sha256(payload);
    const payloadPath = path.join(workDir, "tier-e2e.bin");
    await writeFile(payloadPath, payload);

    // The transfer engine (landed mid-flight from its own lane) routes
    // received bytes through THIS lane's SinkProvider. On default Chromium
    // the winning tier is "download", so the receipt shows up as a real
    // browser download on the GUEST; if the engine were still on the memory
    // path it would be a Save link with a blob URL. Accept and verify either.
    const guestDownloadPromise = guest.page
      .waitForEvent("download", { timeout: 60_000 })
      .catch(() => null);
    await ctxA.page.locator('input[type="file"]').first().setInputFiles(payloadPath);

    const guestDownload = await guestDownloadPromise;
    let receivedVia = null;
    let receivedOk = false;
    if (guestDownload) {
      receivedVia = "download tier (service worker -> download manager)";
      check(
        "received download carries the original filename",
        guestDownload.suggestedFilename() === "tier-e2e.bin",
        guestDownload.suggestedFilename(),
      );
      const savedPath = await guestDownload.path();
      const savedBytes = await readFile(savedPath);
      receivedOk =
        savedBytes.length === payload.length && sha256(savedBytes) === payloadDigest;
    } else {
      receivedVia = "memory tier (blob URL Save link)";
      const saveLink = guest.page.locator("a[download]").first();
      await saveLink.waitFor({ timeout: 15_000 });
      const received = await guest.page.evaluate(async () => {
        const anchor = document.querySelector("a[download]");
        const url = anchor ? anchor.getAttribute("href") : null;
        const blob = url && window.__blobRegistry ? window.__blobRegistry.get(url) : null;
        if (!blob) return null;
        const buffer = await blob.arrayBuffer();
        const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))]
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        return { size: blob.size, digest: hex };
      });
      receivedOk =
        received !== null &&
        received.size === payload.length &&
        received.digest === payloadDigest;
    }
    check(
      `room transfer arrives byte-for-byte via ${receivedVia} (SHA-256 match)`,
      receivedOk,
    );

    // Wait for the guest row to settle on Received before reading row copy.
    for (let i = 0; i < 30; i += 1) {
      const text = await guest.page.locator("body").innerText().catch(() => "");
      if (/received/i.test(text)) break;
      await wait(500);
    }
    // innerText of body only reports VISIBLE text, and the files tab is the
    // active one on both pages, so this reads the files panel's rows.
    const hostPanelText = await ctxA.page.locator("body").innerText().catch(() => "");
    const guestPanelText = await guest.page.locator("body").innerText().catch(() => "");
    check(
      "host row names the peer it sent to",
      /to\s+TierGuest/i.test(hostPanelText),
      JSON.stringify(hostPanelText.slice(0, 200)),
    );
    check(
      "guest row names the peer it came from",
      /from\s+TierHost/i.test(guestPanelText),
      JSON.stringify(guestPanelText.slice(0, 200)),
    );
    if (guestDownload) {
      check(
        "guest row says the file is already saved (no dead Save button)",
        /saved to your downloads folder/i.test(guestPanelText) &&
          (await guest.page.locator("a[download]").count()) === 0,
        JSON.stringify(guestPanelText.slice(0, 300)),
      );
    } else {
      check(
        "guest row reports Received with a Save button (memory tier)",
        /received/i.test(guestPanelText) && /save/i.test(guestPanelText),
      );
    }
    await shot(ctxA.page, "tiers-e2e-host.png");
    await shot(guest.page, "tiers-e2e-guest.png");

    skip(
      "per-row savedTo/resume affordances in the live room",
      "savedTo (filesystem tier) needs a real chosen folder, and resumable/confirmedBytes need the engine lane's resume mechanism mid-failure; both renderings are implemented defensively and the resume mechanism is that lane's verify-transfer-resume.mjs to prove",
    );
    skip(
      "subset-recipient DELIVERY through the engine",
      "SendTargets plumbing in mesh-session/room-client belongs to the engine lane; the UI's selection semantics are fully proven in section 5 and onSend omits targets for the default everyone case, which today's engine already honours",
    );

    await guest.context.close();
    await ctxA.context.close();
  } finally {
    await browser.close();
    await rm(workDir, { recursive: true, force: true });
  }

  console.log(
    `\ndone: ${state.passes} passed, ${state.failures} failed, ${state.skips} skipped`,
  );
  process.exit(state.failures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error("SUITE ERROR:", error);
  process.exit(1);
});
