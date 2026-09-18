import { SubscriptionEventPayload } from "./types";

/**
 * All subscription state changes are surfaced on the Medusa event bus under
 * these names. Business layers (entitlement grants, notifications, dunning)
 * consume them without touching the provider.
 */
export const PaypalSubscriptionEvents = {
  ACTIVATED: "paypal.subscription.activated",
  SUSPENDED: "paypal.subscription.suspended",
  RESUMED: "paypal.subscription.resumed",
  CANCELLED: "paypal.subscription.cancelled",
  EXPIRED: "paypal.subscription.expired",
  PAYMENT_SUCCEEDED: "paypal.subscription.payment_succeeded",
  PAYMENT_FAILED: "paypal.subscription.payment_failed",
} as const;

type EventBusLike = {
  emit: (data: unknown) => Promise<unknown>;
};

/**
 * Event bus emit accepts both the object form and the (name, data) pair;
 * the object form is the documented shape in v2.
 */
export async function emitSubscriptionEvent(
  eventBus: EventBusLike,
  name: string,
  payload: SubscriptionEventPayload
): Promise<void> {
  await eventBus.emit({ name, data: payload });
}
