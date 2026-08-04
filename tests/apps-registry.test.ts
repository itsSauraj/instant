import { describe, expect, it } from "vitest";

import {
  APPS_LIMITS,
  parseAppsManifest,
  sanitizeAppUrl,
  type AppsManifestV1,
} from "@/lib/apps-registry";

/**
 * The registry payload arrives from a host we do not control, so these tests are
 * adversarial by design: they assert what is REFUSED at least as hard as what is
 * accepted. An `href` from a remote origin is an open-redirect vector, so the
 * host allow-list is the control that matters most.
 */

const good = (extra: Record<string, unknown> = {}) => ({
  version: 1 as const,
  apps: [{ id: "ok", name: "Legit", url: "https://github.com/itsSauraj", ...extra }],
});

describe("sanitizeAppUrl", () => {
  it("accepts an allow-listed https host and returns the normalised form", () => {
    expect(sanitizeAppUrl("https://github.com/itsSauraj")).toBe("https://github.com/itsSauraj");
    expect(sanitizeAppUrl("https://saurabh-yadav.me")).toBe("https://saurabh-yadav.me/");
  });

  it("accepts a subdomain of an allow-listed host", () => {
    expect(sanitizeAppUrl("https://apps.saurabh-yadav.me/x")).toBe(
      "https://apps.saurabh-yadav.me/x",
    );
  });

  it("refuses a look-alike host that merely CONTAINS an allowed one", () => {
    // The whole reason the check is endsWith("." + allowed) and not includes().
    expect(sanitizeAppUrl("https://saurabh-yadav.me.evil.com/")).toBeNull();
    expect(sanitizeAppUrl("https://evil.com/?q=github.com")).toBeNull();
    expect(sanitizeAppUrl("https://notgithub.com")).toBeNull();
  });

  it("refuses every scheme except https", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "vbscript:msgbox",
      "blob:https://github.com/abc",
      "file:///etc/passwd",
      "http://github.com",
    ]) {
      expect(sanitizeAppUrl(url), url).toBeNull();
    }
  });

  it("refuses embedded credentials, which disguise the real destination", () => {
    expect(sanitizeAppUrl("https://user:pw@github.com")).toBeNull();
    expect(sanitizeAppUrl("https://github.com@evil.com")).toBeNull();
  });

  it("refuses junk", () => {
    expect(sanitizeAppUrl("")).toBeNull();
    expect(sanitizeAppUrl("   ")).toBeNull();
    expect(sanitizeAppUrl("not a url")).toBeNull();
    expect(sanitizeAppUrl(null)).toBeNull();
    expect(sanitizeAppUrl(42)).toBeNull();
  });
});

describe("parseAppsManifest", () => {
  it("accepts a valid manifest", () => {
    const parsed = parseAppsManifest(good());
    expect(parsed?.apps).toHaveLength(1);
    expect(parsed?.apps[0].name).toBe("Legit");
  });

  it("rejects an unknown version wholesale, so a v2 remote cannot half-render", () => {
    expect(parseAppsManifest({ ...good(), version: 2 })).toBeNull();
    expect(parseAppsManifest({ ...good(), version: "1" })).toBeNull();
    expect(parseAppsManifest({ apps: [] })).toBeNull();
  });

  it("rejects a non-object or a missing apps array", () => {
    expect(parseAppsManifest(null)).toBeNull();
    expect(parseAppsManifest("nope")).toBeNull();
    expect(parseAppsManifest({ version: 1, apps: "nope" })).toBeNull();
  });

  it("drops a bad entry but keeps the good ones (fail-soft per entry)", () => {
    const parsed = parseAppsManifest({
      version: 1,
      apps: [
        { id: "a", name: "Bad scheme", url: "javascript:alert(1)" },
        { id: "b", name: "Suffix", url: "https://saurabh-yadav.me.evil.com" },
        { id: "c", name: "Keeper", url: "https://github.com/x" },
        { id: "d", name: "", url: "https://github.com/y" },
        "not an object",
      ],
    });
    expect(parsed?.apps.map((app) => app.name)).toEqual(["Keeper"]);
  });

  it("never renders a remote icon: unknown names fall back to a local one", () => {
    // An SVG string here would be an XSS sink if it were ever interpolated.
    const parsed = parseAppsManifest(good({ icon: "<svg onload=alert(1)>" }));
    expect(parsed?.apps[0].icon).toBe("grid");
    expect(parseAppsManifest(good({ icon: "video" }))?.apps[0].icon).toBe("video");
  });

  it("snaps accent and badge to the local palette", () => {
    expect(parseAppsManifest(good({ accent: "red; background: url(x)" }))?.apps[0].accent).toBe(
      "neutral",
    );
    expect(parseAppsManifest(good({ accent: "success" }))?.apps[0].accent).toBe("success");
    expect(parseAppsManifest(good({ badge: "urgent" }))?.apps[0].badge).toBeUndefined();
    expect(parseAppsManifest(good({ badge: "beta" }))?.apps[0].badge).toBe("beta");
  });

  it("strips bidi overrides, which let a label render as a different string", () => {
    const parsed = parseAppsManifest(good({ name: "safe‮eslaf‬" }));
    expect(parsed?.apps[0].name).not.toContain("‮");
    expect(parsed?.apps[0].name).not.toContain("‬");
  });

  it("clamps text lengths", () => {
    const parsed = parseAppsManifest(
      good({ name: "n".repeat(200), description: "d".repeat(400), group: "g".repeat(80) }),
    );
    expect(parsed?.apps[0].name.length).toBeLessThanOrEqual(APPS_LIMITS.maxNameLength);
    expect(parsed?.apps[0].description?.length ?? 0).toBeLessThanOrEqual(
      APPS_LIMITS.maxDescriptionLength,
    );
    expect(parsed?.apps[0].group?.length ?? 0).toBeLessThanOrEqual(APPS_LIMITS.maxGroupLength);
  });

  it("caps the number of entries", () => {
    const many = {
      version: 1 as const,
      apps: Array.from({ length: 500 }, (_, i) => ({
        id: `app-${i}`,
        name: `App ${i}`,
        url: "https://github.com/x",
      })),
    };
    expect(parseAppsManifest(many)?.apps.length).toBeLessThanOrEqual(APPS_LIMITS.maxEntries);
  });

  it("de-duplicates ids so React keys stay unique", () => {
    const parsed = parseAppsManifest({
      version: 1,
      apps: [
        { id: "same", name: "First", url: "https://github.com/a" },
        { id: "same", name: "Second", url: "https://github.com/b" },
      ],
    });
    expect(parsed?.apps).toHaveLength(1);
  });

  it("always yields a non-empty id for a stable key", () => {
    const parsed = parseAppsManifest(good({ id: "!!!" }));
    expect(parsed?.apps[0].id).toBeTruthy();
  });

  it("orders by the remote's order field, breaking ties by name", () => {
    const parsed = parseAppsManifest({
      version: 1,
      apps: [
        { id: "c", name: "Charlie", url: "https://github.com/c", order: 2 },
        { id: "a", name: "Alpha", url: "https://github.com/a", order: 1 },
        { id: "b", name: "Bravo", url: "https://github.com/b", order: 1 },
      ],
    } satisfies AppsManifestV1);
    expect(parsed?.apps.map((app) => app.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });
});
