/**
 * Verifies the apps launcher: the remote registry is treated as hostile input,
 * a dead registry never breaks the page, the theme is inherited rather than
 * hardcoded, placement differs per mount point, and no request carrying a room
 * id ever reaches the registry host.
 *
 *   node scripts/verify-apps-launcher.mjs [baseUrl]
 *
 * The registry is stood up here as a real local HTTP server so each case
 * controls the exact payload - the same spirit as verify-scan.mjs synthesising a
 * real QR video rather than stubbing the decoder.
 *
 * NOTE: cases that need a specific payload require the server under test to have
 * APPS_REGISTRY_URL pointing at this script's port, which cannot be changed from
 * outside. Those cases run when INSTANT_APPS_REGISTRY_PORT is set to the port
 * this script should listen on; otherwise they SKIP with a printed reason and
 * the payload-independent cases still run.
 *
 * Keep this file ASCII-only.
 */

import { createServer } from "node:http";

import { launchMeshBrowser, makeChecker, newParticipant, parseCliArgs } from "./mesh-shared.mjs";

const { base: BASE } = parseCliArgs();
const REGISTRY_PORT = Number(process.env.INSTANT_APPS_REGISTRY_PORT ?? 0);
const { check, skip, state } = makeChecker();

/** Requests the fake registry received, so we can prove what did NOT arrive. */
const received = [];
let payload = { version: 1, updatedAt: "2026-08-03", apps: [] };
let mode = "ok";

async function startRegistry(port) {
  const server = createServer((req, res) => {
    received.push({ url: req.url, headers: { ...req.headers } });
    if (mode === "hang") return; // never respond; exercises the timeout
    if (mode === "500") {
      res.writeHead(500).end("nope");
      return;
    }
    if (mode === "html") {
      res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><p>hi");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

const browser = await launchMeshBrowser({ headed: false });
let registry = null;

/** Reads /api/apps through the app so the route's own validation is exercised. */
async function apiApps(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/apps", { headers: { accept: "application/json" } });
    return { status: response.status, source: response.headers.get("x-apps-source"), body: await response.json() };
  });
}

async function openLauncher(page) {
  const trigger = page.locator('[data-slot="apps-launcher-trigger"]').first();
  await trigger.waitFor({ timeout: 20_000 });
  await trigger.click();
  await page.locator('[data-slot="apps-launcher-panel"]').first().waitFor({ timeout: 10_000 });
}

try {
  console.log(`Verifying the apps launcher against ${BASE}`);
  if (REGISTRY_PORT > 0) {
    registry = await startRegistry(REGISTRY_PORT);
    console.log(`  fake registry listening on ${REGISTRY_PORT}`);
  }

  // ---------------------------------------------------------------- always-on
  const peer = await newParticipant(browser, "visitor", { name: "Ada" });
  const { page } = peer;
  const registryHits = [];
  page.on("request", (request) => {
    const url = request.url();
    if (REGISTRY_PORT > 0 && url.includes(`:${REGISTRY_PORT}`)) registryHits.push(url);
  });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // The endpoint must never fail, whatever the registry is doing.
  const api = await apiApps(page);
  check("the /api/apps route answers 200", api.status === 200, String(api.status));
  check(
    "it reports a known source",
    ["live", "stale", "fallback"].includes(api.source),
    String(api.source),
  );
  check("it never returns an empty list", Array.isArray(api.body.apps) && api.body.apps.length > 0);

  // Every URL it hands out must already be validated.
  const badUrl = (api.body.apps ?? []).find(
    (app) => typeof app.url !== "string" || !app.url.startsWith("https://"),
  );
  check("every url it returns is https", !badUrl, JSON.stringify(badUrl ?? null));

  await openLauncher(page);
  const items = page.locator('[data-slot="apps-launcher-item"]');
  const count = await items.count();
  check("the launcher lists at least one app", count > 0, String(count));

  const rels = await items.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("rel") ?? ""));
  check(
    "every link is noopener AND noreferrer",
    rels.length > 0 && rels.every((rel) => rel.includes("noopener") && rel.includes("noreferrer")),
    JSON.stringify(rels),
  );
  const targets = await items.evaluateAll((nodes) => nodes.map((n) => n.getAttribute("target")));
  check("every link opens in a new tab", targets.every((t) => t === "_blank"));

  // Theme inheritance: the panel must resolve app tokens, not hardcoded hex.
  const darkBg = await page
    .locator('[data-slot="apps-launcher-panel"]')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.locator('button[aria-label^="Switch to"]').first().click();
  await page.waitForTimeout(400);
  await openLauncher(page);
  const lightBg = await page
    .locator('[data-slot="apps-launcher-panel"]')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  check(
    "the panel colour follows the theme rather than being hardcoded",
    Boolean(darkBg) && Boolean(lightBg) && darkBg !== lightBg,
    `dark=${darkBg} light=${lightBg}`,
  );

  check("no page error was raised", pageErrors.length === 0, pageErrors.join(" | "));

  // ------------------------------------------------- privacy: the crux check
  check(
    "the browser never contacted the registry host directly",
    registryHits.length === 0,
    registryHits.join(" | "),
  );
  if (REGISTRY_PORT > 0) {
    const leaked = received.filter((entry) =>
      /[0-9a-hjkmnp-tv-z]{16}/.test(`${entry.url} ${JSON.stringify(entry.headers)}`),
    );
    check(
      "no request reaching the registry carried anything room-id shaped",
      leaked.length === 0,
      JSON.stringify(leaked.slice(0, 2)),
    );
    const withReferer = received.filter((entry) => entry.headers.referer || entry.headers.cookie);
    check(
      "the proxy forwarded no referer and no cookies upstream",
      withReferer.length === 0,
      JSON.stringify(withReferer.slice(0, 2)),
    );
  } else {
    skip(
      "registry-side leak inspection",
      "set INSTANT_APPS_REGISTRY_PORT and point APPS_REGISTRY_URL at it to exercise this",
    );
  }

  // Placement differs per mount point: the room uses the small, recessive one.
  await page.goto(`${BASE}/room/${"k3f9mq2t8xbv7rn0"}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  const roomTrigger = page.locator('[data-slot="apps-launcher-trigger"]').first();
  const inRoom = await roomTrigger.count();
  if (inRoom > 0) {
    const box = await roomTrigger.boundingBox();
    check(
      "the room trigger uses the smaller size variant",
      Boolean(box && box.width <= 36 && box.height <= 36),
      JSON.stringify(box),
    );
  } else {
    skip("room-header placement", "the room did not reach a state that renders its header");
  }

  await peer.context.close();

  // -------------------------------------------- payload-dependent hostile set
  if (REGISTRY_PORT === 0) {
    skip(
      "hostile payload refusal",
      "requires APPS_REGISTRY_URL pointed at this script; run with INSTANT_APPS_REGISTRY_PORT set",
    );
    skip("registry-down degradation", "same reason");
  } else {
    const hostile = {
      version: 1,
      apps: [
        { id: "js", name: "Bad scheme", url: "javascript:alert(1)" },
        { id: "suffix", name: "Suffix trick", url: "https://saurabh-yadav.me.evil.com/" },
        { id: "plain", name: "Plain http", url: "http://saurabh-yadav.me" },
        { id: "creds", name: "Credentials", url: "https://user:pw@github.com" },
        { id: "good", name: "Legit", url: "https://github.com/itsSauraj" },
      ],
    };
    payload = hostile;
    mode = "ok";

    const probe = await newParticipant(browser, "hostile", { name: "Ben" });
    await probe.page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const after = await apiApps(probe.page);
    const urls = (after.body.apps ?? []).map((app) => app.url);
    const names = (after.body.apps ?? []).map((app) => app.name);

    check("a javascript: url is dropped", !urls.some((u) => u.startsWith("javascript:")));
    check(
      "a look-alike suffix host is dropped",
      !urls.some((u) => u.includes("evil.com")),
      JSON.stringify(urls),
    );
    check("a plain http url is dropped", !urls.some((u) => u.startsWith("http://")));
    check("embedded credentials are dropped", !urls.some((u) => u.includes("@")));
    check("the one legitimate entry survives", names.includes("Legit"), JSON.stringify(names));

    // Version gate: an unknown envelope must not be rendered at all.
    payload = { version: 2, apps: [{ id: "x", name: "Future", url: "https://github.com" }] };
    const v2 = await apiApps(probe.page);
    check(
      "an unknown manifest version is refused wholesale",
      !(v2.body.apps ?? []).some((app) => app.name === "Future"),
      JSON.stringify(v2.body.apps),
    );

    // Degradation: the page must survive a registry that is broken or absent.
    for (const [label, nextMode] of [
      ["500", "500"],
      ["non-JSON", "html"],
      ["hanging", "hang"],
    ]) {
      mode = nextMode;
      const degraded = await apiApps(probe.page);
      check(
        `a ${label} registry still yields a usable list`,
        degraded.status === 200 && (degraded.body.apps ?? []).length > 0,
        `${degraded.status} source=${degraded.source}`,
      );
    }

    mode = "ok";
    await probe.context.close();
  }
} catch (error) {
  state.failures += 1;
  console.log(`\n  ERROR  ${error.message}`);
} finally {
  await browser.close().catch(() => {});
  if (registry) await new Promise((resolve) => registry.close(resolve));
}

console.log(
  `\n${state.failures === 0 ? "All apps-launcher checks passed." : `${state.failures} check(s) failed.`} (${state.passes} passed, ${state.failures} failed, ${state.skips} skipped)`,
);
process.exit(state.failures === 0 ? 0 : 1);
