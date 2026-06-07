// Runtime pairing-store bridge for channel ingress allowlist fallback.
import type { PairingChannel } from "../../pairing/pairing-store.types.js";

/**
 * Read pairing-store allowlist entries when a direct-message policy permits
 * store fallback.
 */
export async function readChannelIngressStoreAllowFromForDmPolicy(params: {
  provider: PairingChannel;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: PairingChannel, accountId: string) => Promise<string[]>;
}): Promise<string[]> {
  if (
    params.shouldRead === false ||
    params.dmPolicy === "allowlist" ||
    params.dmPolicy === "open"
  ) {
    return [];
  }
  const readStore =
    params.readStore ??
    (async (provider: PairingChannel, accountId: string) => {
      const { readChannelAllowFromStore } = await import("../../pairing/pairing-store.js");
      return await readChannelAllowFromStore(provider, process.env, accountId);
    });
  return await readStore(params.provider, params.accountId).catch(() => []);
}
