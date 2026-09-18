import { WebhookPayload } from "../providers/paypal/types";

/**
 * Local subscription lifecycle states. APPROVAL_PENDING is set when the
 * PayPal subscription is created but the buyer has not approved it yet;
 * ACTIVE only ever arrives through BILLING.SUBSCRIPTION.ACTIVATED (or a
 * PayPal re-query), never from a money event.
 */
export type PaypalSubscriptionStatus =
  | "APPROVAL_PENDING"
  | "ACTIVE"
  | "SUSPENDED"
  | "CANCELLED"
  | "EXPIRED";

export const SUBSCRIPTION_STATUSES: PaypalSubscriptionStatus[] = [
  "APPROVAL_PENDING",
  "ACTIVE",
  "SUSPENDED",
  "CANCELLED",
  "EXPIRED",
];

/**
 * One renewal (or trial-end) charge recorded against a subscription row.
 * `sale_id` doubles as the PayPal refund lookup anchor and the
 * already-processed marker that keeps duplicate SALE webhooks idempotent.
 */
export type SubscriptionSaleRecord = {
  sale_id: string;
  order_id: string;
  payment_collection_id?: string;
  payment_id?: string;
  amount: number;
  currency_code: string;
  billed_at?: string;
};

export type SubscriptionRefundRecord = {
  refund_id: string;
  sale_id: string;
  order_id: string | null;
  amount: number;
  currency_code: string;
  refunded_at: string;
};

export type SubscriptionEventPayload = {
  subscription_id: string;
  paypal_subscription_id: string;
  status: PaypalSubscriptionStatus;
  customer_id?: string | null;
  variant_id?: string | null;
  payment?: {
    amount: number;
    currency_code: string;
    sale_id: string;
    order_id?: string;
  };
};

/** The payload our public subscription webhook route forwards. */
export type SubscriptionWebhookPayload = WebhookPayload;
