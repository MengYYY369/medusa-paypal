import type { MedusaContainer } from "@medusajs/framework/types";

/**
 * The rail contract, declared locally (decision 1, 2026-10-06).
 *
 * `medusa-payment-methods` owns these shapes, but this package deliberately
 * does **not** import that package: it is private-scope, and a published
 * provider whose `.d.ts` imports it would break any consumer with
 * `skipLibCheck: false`. The contract is therefore redeclared here, and three
 * things hold the two copies together:
 *
 * 1. the host-side `satisfies PaymentProviderDescriptor` assertion in
 *    `medusa-config.ts` (the only place that sees both packages),
 * 2. this package's own tests, which feed the canonical fixture payloads
 *    through the descriptor, and
 * 3. the release checklist's `diff` of the fixture copy against the canonical
 *    file in `medusa-payment-methods/src/contract/`.
 *
 * The provider is the *caller* side of the rail: it never emits an event and
 * never knows the event's name. The host injects
 * `onNativeSubscriptionChanged`; the provider hands it one of these payloads.
 */

/** The rail-neutral status vocabulary. */
export type RailStatus = "active" | "paused" | "past_due" | "cancelled";

/** Why a row changed. Carries what the provider's own event names used to. */
export type NativeSubscriptionTransition =
  | "status"
  | "payment_succeeded"
  | "payment_failed";

/** One native subscription, as this provider knows it. */
export type NativeSubscriptionRecord = {
  provider_subscription_id: string;
  plan_id: string | null;
  /** `null` = do not mirror (`APPROVAL_PENDING` maps here). */
  status: RailStatus | null;
  customer_id: string | null;
  variant_id: string | null;
  interval_unit: string;
  interval_count: number;
  /** ISO strings — the value has to survive the event bus' JSON round-trip. */
  next_billing_at: string | null;
  last_billing_at: string | null;
};

/** The complete record plus the two facts only the provider knows. */
export type NativeSubscriptionChangedPayload = NativeSubscriptionRecord & {
  kind: string;
  /** The row's payment-session echo, often `null` — never a join key. */
  provider_id: string | null;
  transition: NativeSubscriptionTransition;
};

/** The hook the host injects (its return value is the bus' own). */
export type NativeSubscriptionChangedHook = (
  eventBus: unknown,
  payload: NativeSubscriptionChangedPayload,
) => Promise<unknown>;

/** What the variant metadata of one declaration holds, as the admin shows it. */
export type NativeDeclaration = {
  fields: Array<{ key: string; label: string; value: string | null }>;
};

/** The answer to a cancel attempt. */
export type NativeCancelOutcome =
  | {
      status: "skipped";
      reason: "not_native" | "provider_row_missing" | "capability_absent";
    }
  | {
      status: "cancelled";
      provider_subscription_id: string;
      provider_row_id: string | null;
    }
  | {
      status: "failed";
      provider_subscription_id: string | null;
      provider_row_id: string | null;
      error: string;
    };

/** The native rail: what a consumer may do with this provider's subscriptions. */
export type NativeRailDescriptor = {
  readVariantDeclaration(
    metadata: Record<string, unknown> | null,
  ): NativeDeclaration | null;
  listRecords(container: MedusaContainer): Promise<NativeSubscriptionRecord[]>;
  /**
   * `reference` is this provider's own subscription id, never a mirror key.
   * A subscription this provider does not know is `skipped`, not an error.
   */
  cancel(
    container: MedusaContainer,
    reference: string,
  ): Promise<NativeCancelOutcome>;
};

/** The binding protocol, as `medusa-payment-methods` calls it. */
export type PaymentMethodBinder = {
  start(input: {
    customerId: string;
    providerId: string;
    returnUrl: string;
    cancelUrl: string;
  }): Promise<{ approvalUrl: string; state: string }>;
  complete(input: {
    customerId: string;
    providerId: string;
    state: string;
  }): Promise<{ paymentMethodId: string; data: Record<string, unknown> }>;
  /** "the approval was already exchanged" — replays as an idempotent success. */
  isAlreadyCompleted?(error: unknown): boolean;
  /** "the payer has not approved yet" — the plugin answers 422, not a 502. */
  isPendingApproval?(error: unknown): boolean;
};

/** Everything `medusa-payment-methods` needs to know about this provider. */
export type PaymentProviderDescriptor = {
  provider_id: string;
  kind: string;
  display_name: string;
  display_name_i18n?: Record<string, string>;
  binding: PaymentMethodBinder;
  native?: NativeRailDescriptor;
  mapError?: (error: unknown) => { status: number; type: string } | null;
};
