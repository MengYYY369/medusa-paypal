import type {
  NativeSubscriptionChangedPayload,
  NativeSubscriptionTransition,
} from "../types";

/**
 * A verbatim copy of the canonical rail fixture in
 * `medusa-payment-methods/src/contract/native-subscription-changed.fixture.ts`
 * (payloads only — this package never knows the event's name, which is the
 * whole point of the injected hook).
 *
 * It exists so this package's tests assert the *contract* payloads rather than
 * an invented shape: the dead event path this replaces survived because each
 * repository tested its own half against its own idea of the same event. The
 * release checklist diffs this file's payloads against the canonical one.
 */
export const nativeSubscriptionChangedPayloads: Record<
  | "activated"
  | "renewed"
  | "paymentFailed"
  | "paused"
  | "cancelled"
  | "statusRefresh",
  NativeSubscriptionChangedPayload
> = {
  activated: {
    provider_subscription_id: "I-BW452GLLEP1G",
    plan_id: "P-5ML4271244454362WXNWU5NQ",
    status: "active",
    customer_id: "cus_01HZ6W0S8V9K2M4N7P1Q3R5T",
    variant_id: "variant_01HZ6W0S8V9K2M4N7P1Q3R5U",
    interval_unit: "month",
    interval_count: 1,
    next_billing_at: "2026-11-06T09:12:44.000Z",
    last_billing_at: "2026-10-06T09:12:44.000Z",
    kind: "paypal",
    provider_id: "pp_paypal_paypal",
    transition: "payment_succeeded",
  },
  renewed: {
    provider_subscription_id: "I-BW452GLLEP1G",
    plan_id: "P-5ML4271244454362WXNWU5NQ",
    status: "active",
    customer_id: "cus_01HZ6W0S8V9K2M4N7P1Q3R5T",
    variant_id: "variant_01HZ6W0S8V9K2M4N7P1Q3R5U",
    interval_unit: "month",
    interval_count: 1,
    next_billing_at: "2026-12-06T09:12:44.000Z",
    last_billing_at: "2026-11-06T09:12:44.000Z",
    kind: "paypal",
    provider_id: "pp_paypal_paypal",
    transition: "payment_succeeded",
  },
  paymentFailed: {
    provider_subscription_id: "I-BW452GLLEP1G",
    plan_id: "P-5ML4271244454362WXNWU5NQ",
    status: "past_due",
    customer_id: "cus_01HZ6W0S8V9K2M4N7P1Q3R5T",
    variant_id: "variant_01HZ6W0S8V9K2M4N7P1Q3R5U",
    interval_unit: "month",
    interval_count: 1,
    next_billing_at: "2026-10-13T09:12:44.000Z",
    last_billing_at: "2026-10-06T09:12:44.000Z",
    kind: "paypal",
    provider_id: "pp_paypal_paypal",
    transition: "payment_failed",
  },
  paused: {
    provider_subscription_id: "I-BW452GLLEP1G",
    plan_id: "P-5ML4271244454362WXNWU5NQ",
    status: "paused",
    customer_id: "cus_01HZ6W0S8V9K2M4N7P1Q3R5T",
    variant_id: "variant_01HZ6W0S8V9K2M4N7P1Q3R5U",
    interval_unit: "month",
    interval_count: 1,
    next_billing_at: null,
    last_billing_at: "2026-10-06T09:12:44.000Z",
    kind: "paypal",
    provider_id: "pp_paypal_paypal",
    transition: "status",
  },
  cancelled: {
    provider_subscription_id: "I-BW452GLLEP1G",
    plan_id: "P-5ML4271244454362WXNWU5NQ",
    status: "cancelled",
    customer_id: "cus_01HZ6W0S8V9K2M4N7P1Q3R5T",
    variant_id: "variant_01HZ6W0S8V9K2M4N7P1Q3R5U",
    interval_unit: "month",
    interval_count: 1,
    next_billing_at: null,
    last_billing_at: "2026-10-06T09:12:44.000Z",
    kind: "paypal",
    provider_id: "pp_paypal_paypal",
    transition: "status",
  },
  statusRefresh: {
    provider_subscription_id: "I-BW452GLLEP1G",
    plan_id: "P-5ML4271244454362WXNWU5NQ",
    status: "active",
    customer_id: "cus_01HZ6W0S8V9K2M4N7P1Q3R5T",
    variant_id: "variant_01HZ6W0S8V9K2M4N7P1Q3R5U",
    interval_unit: "month",
    interval_count: 1,
    next_billing_at: "2026-11-06T09:12:44.000Z",
    last_billing_at: "2026-10-06T09:12:44.000Z",
    kind: "paypal",
    provider_id: null,
    transition: "status",
  },
};

/** The transitions the fixture covers, for a completeness assertion. */
export const nativeSubscriptionChangedTransitions: NativeSubscriptionTransition[] = [
  "status",
  "payment_succeeded",
  "payment_failed",
];
