// Control UI tests cover provider quota summary behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatQuotaReset, groupQuotaWindowsByProvider } from "./provider-quota-summary.ts";

describe("formatQuotaReset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns compact relative reset windows", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));

    expect(formatQuotaReset(Date.now() + 30 * 60_000)).toBe("30m");
    expect(formatQuotaReset(Date.now() + 2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("ignores Date-invalid reset timestamps", () => {
    expect(formatQuotaReset(8_640_000_000_000_001)).toBeNull();
    expect(formatQuotaReset(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("groupQuotaWindowsByProvider", () => {
  it("keeps each provider separate and orders providers most-constrained first", () => {
    const grouped = groupQuotaWindowsByProvider([
      { displayName: "OpenAI", label: "Week", remaining: 28 },
      { displayName: "Claude", label: "5h", remaining: 40, resetAt: 1_700_000_000_000 },
      { displayName: "Claude", label: "Week", remaining: 65 },
      { displayName: "OpenAI", label: "3h", remaining: 82 },
    ]);

    expect(grouped.map((p) => p.displayName)).toEqual(["OpenAI", "Claude"]);
    expect(grouped[0]).toMatchObject({ displayName: "OpenAI", remaining: 28 });
    expect(grouped[0]?.windows.map((w) => w.label)).toEqual(["Week", "3h"]);
    expect(grouped[1]).toMatchObject({ displayName: "Claude", remaining: 40 });
    expect(grouped[1]?.windows.map((w) => w.label)).toEqual(["5h", "Week"]);
  });

  it("breaks remaining ties by provider name and returns empty for no windows", () => {
    const grouped = groupQuotaWindowsByProvider([
      { displayName: "OpenAI", label: "Week", remaining: 30 },
      { displayName: "Claude", label: "5h", remaining: 30 },
    ]);

    expect(grouped.map((p) => p.displayName)).toEqual(["Claude", "OpenAI"]);
    expect(groupQuotaWindowsByProvider([])).toEqual([]);
  });
});
