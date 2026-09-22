import { describe, expect, it } from "vitest";
import { describeLink } from "@/lib/link-label";

describe("describeLink", () => {
  it("names a bare URL after its site, with the path as the detail", () => {
    expect(describeLink("https://github.com/itsSauraj/instant", "https://github.com/itsSauraj/instant")).toEqual({
      label: "github.com",
      detail: "/itsSauraj/instant",
      bare: true,
    });
  });

  it("drops www., trailing slashes and query noise from a bare URL", () => {
    expect(describeLink("https://www.example.com/", "https://www.example.com/")).toEqual({
      label: "example.com",
      detail: null,
      bare: true,
    });
    expect(describeLink("https://example.com/docs/?tab=1#top", "https://example.com/docs/?tab=1#top")).toEqual({
      label: "example.com",
      detail: "/docs",
      bare: true,
    });
  });

  it("treats an autolink whose text lacks the scheme as bare", () => {
    // remark-gfm autolinks `www.example.com/x` with an http:// href.
    expect(describeLink("http://www.example.com/x", "www.example.com/x")).toMatchObject({
      label: "example.com",
      detail: "/x",
      bare: true,
    });
  });

  it("keeps a markdown label and shows the host as the detail", () => {
    expect(describeLink("https://docs.example.com/guide", "the guide")).toEqual({
      label: "the guide",
      detail: "docs.example.com",
      bare: false,
    });
  });

  it("does not repeat a label that already is the host", () => {
    expect(describeLink("https://github.com", "github.com")).toEqual({
      label: "github.com",
      detail: null,
      bare: true,
    });
    expect(describeLink("https://github.com/about", "GitHub.com")).toEqual({
      label: "GitHub.com",
      detail: null,
      bare: false,
    });
  });

  it("shortens long paths", () => {
    const long = "/a/very/long/path/that/keeps/going/and/going/forever";
    const out = describeLink(`https://example.com${long}`, `https://example.com${long}`);
    expect(out?.detail?.length).toBe(32);
    expect(out?.detail?.endsWith("…")).toBe(true);
  });

  it("decodes escaped path segments for display", () => {
    expect(describeLink("https://example.com/caf%C3%A9", "https://example.com/caf%C3%A9")?.detail).toBe(
      "/café",
    );
  });

  it("handles mailto links", () => {
    expect(describeLink("mailto:ada@example.com", "mailto:ada@example.com")).toEqual({
      label: "ada@example.com",
      detail: null,
      bare: true,
    });
    expect(describeLink("mailto:ada@example.com", "email Ada")).toEqual({
      label: "email Ada",
      detail: "ada@example.com",
      bare: false,
    });
  });

  it("returns null for anything that is not an absolute http(s) or mailto URL", () => {
    expect(describeLink(undefined, "x")).toBeNull();
    expect(describeLink("/relative/path", "x")).toBeNull();
    expect(describeLink("ftp://files.example.com", "x")).toBeNull();
    expect(describeLink("not a url", "x")).toBeNull();
  });
});
