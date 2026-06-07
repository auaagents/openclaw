// Delivery context helpers normalize target and route metadata for delivery.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeMessageChannel } from "./message-channel.js";
export {
  channelRouteFromDeliveryContext,
  deliveryContextFromChannelRoute,
  deliveryContextFromSession,
  deliveryContextKey,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "./delivery-context.shared.js";
export type { DeliveryContext, DeliveryContextSessionSource } from "./delivery-context.types.js";

type ConversationTargetParams = {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
};

function normalizeConversationId(value: string | number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? String(Math.trunc(value))
    : typeof value === "string"
      ? normalizeOptionalString(value)
      : undefined;
}

function normalizeConversationTargetParams(params: ConversationTargetParams): {
  channel?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const channel =
    typeof params.channel === "string"
      ? (normalizeMessageChannel(params.channel) ?? params.channel.trim())
      : undefined;
  const conversationId = normalizeConversationId(params.conversationId);
  const parentConversationId = normalizeConversationId(params.parentConversationId);
  return { channel, conversationId, parentConversationId };
}

/** Formats a conversation id into a generic deliverable target. */
export function formatConversationTarget(params: ConversationTargetParams): string | undefined {
  const { channel, conversationId } = normalizeConversationTargetParams(params);
  if (!channel || !conversationId) {
    return undefined;
  }
  return `channel:${conversationId}`;
}

/** Resolves a channel conversation into generic target fields for delivery routing. */
export function resolveConversationDeliveryTarget(params: {
  channel?: string;
  conversationId?: string | number;
  parentConversationId?: string | number;
}): { to?: string; threadId?: string } {
  const to = formatConversationTarget(params);
  return { to };
}
