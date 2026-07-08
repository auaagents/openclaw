// Control UI module implements provider quota summary behavior.
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";

export type QuotaWindowSummary = {
  displayName: string;
  label: string;
  remaining: number;
  resetAt?: number;
};

export type ProviderQuotaSummary = {
  displayName: string;
  /** This provider's windows, most-constrained first. */
  windows: QuotaWindowSummary[];
  /** Remaining percent of this provider's most-constrained window. */
  remaining: number;
};

export function formatQuotaReset(resetAt?: number): string | null {
  const timestampMs = asDateTimestampMs(resetAt);
  if (timestampMs === undefined) {
    return null;
  }
  const diffMs = timestampMs - Date.now();
  if (diffMs <= 0) {
    return "now";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  return new Date(timestampMs).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function collectQuotaWindows(
  providers: ReadonlyArray<ModelAuthStatusProvider>,
): QuotaWindowSummary[] {
  return providers
    .flatMap((provider) =>
      (provider.usage?.windows ?? []).map((window) => ({
        displayName: provider.displayName,
        label: (window.label || "").trim(),
        remaining: Math.max(0, Math.min(100, Math.round(100 - window.usedPercent))),
        resetAt: window.resetAt,
      })),
    )
    .toSorted((a, b) => a.remaining - b.remaining || a.displayName.localeCompare(b.displayName));
}

/**
 * Group flat quota windows by provider so UI surfaces can show each provider's
 * quota side by side (e.g. Claude vs OpenAI) instead of one blended number.
 * Providers are ordered most-constrained first.
 */
export function groupQuotaWindowsByProvider(
  windows: ReadonlyArray<QuotaWindowSummary>,
): ProviderQuotaSummary[] {
  const byProvider = new Map<string, QuotaWindowSummary[]>();
  for (const window of windows) {
    const existing = byProvider.get(window.displayName);
    if (existing) {
      existing.push(window);
    } else {
      byProvider.set(window.displayName, [window]);
    }
  }
  return [...byProvider.entries()]
    .map(([displayName, providerWindows]) => {
      const sorted = providerWindows.toSorted((a, b) => a.remaining - b.remaining);
      return {
        displayName,
        windows: sorted,
        remaining: sorted[0]?.remaining ?? 100,
      };
    })
    .toSorted((a, b) => a.remaining - b.remaining || a.displayName.localeCompare(b.displayName));
}

export function collectQuotaWindowsFromAuthStatus(
  status: ModelAuthStatusResult | null,
  filter: (provider: ModelAuthStatusProvider) => boolean,
): QuotaWindowSummary[] {
  return collectQuotaWindows((status?.providers ?? []).filter(filter));
}
