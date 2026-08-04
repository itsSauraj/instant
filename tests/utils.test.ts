import { describe, expect, it } from "vitest";
import { cn, formatBytes, formatDuration } from "@/lib/utils";

describe("formatBytes", () => {
  it("renders zero, negatives and non-finite input as 0 B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(-5)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
    expect(formatBytes(Infinity)).toBe("0 B");
  });

  it("keeps byte counts whole", () => {
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("steps through the 1024-based units", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
    expect(formatBytes(1024 ** 3)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("clamps beyond the largest unit instead of inventing one", () => {
    expect(formatBytes(1024 ** 5)).toBe("1024.0 TB");
  });

  it("honours the digits parameter", () => {
    expect(formatBytes(1536, 2)).toBe("1.50 KB");
    expect(formatBytes(1536, 0)).toBe("2 KB");
  });
});

describe("formatDuration", () => {
  it("renders invalid input as 00:00", () => {
    expect(formatDuration(-1)).toBe("00:00");
    expect(formatDuration(NaN)).toBe("00:00");
    expect(formatDuration(Infinity)).toBe("00:00");
  });

  it("renders minutes and seconds zero-padded", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(59)).toBe("00:59");
    expect(formatDuration(65)).toBe("01:05");
    expect(formatDuration(599)).toBe("09:59");
  });

  it("adds an hours field only past the hour", () => {
    expect(formatDuration(3599)).toBe("59:59");
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(3661)).toBe("1:01:01");
    expect(formatDuration(36000)).toBe("10:00:00");
  });

  it("floors fractional seconds", () => {
    expect(formatDuration(59.9)).toBe("00:59");
  });
});

describe("cn", () => {
  it("drops falsy class values", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c");
  });

  it("lets later tailwind utilities win conflicts", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
