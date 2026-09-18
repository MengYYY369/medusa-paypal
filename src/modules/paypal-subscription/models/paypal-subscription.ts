import { model } from "@medusajs/framework/utils";

/**
 * Local mirror of one PayPal subscription. `payment_session_id` anchors the
 * webhook path back to the originating payment session; `first_sale_id`
 * separates the first charge (standard cart-completion flow) from renewals;
 * `sales` / `refunds` keep the processed-event records that make webhook
 * handling idempotent and give refund lookups their anchors.
 */
const PaypalSubscription = model.define("PaypalSubscription", {
  id: model.id({ prefix: "ppsub" }).primaryKey(),
  paypal_subscription_id: model.text().unique(),
  paypal_plan_id: model.text().nullable(),
  variant_id: model.text().index("IDX_paypal_subscription_variant"),
  customer_id: model
    .text()
    .index("IDX_paypal_subscription_customer")
    .nullable(),
  payment_session_id: model.text().index("IDX_paypal_subscription_session"),
  payment_collection_id: model.text().nullable(),
  provider_id: model.text().nullable(),
  status: model.text().default("APPROVAL_PENDING"),
  /** Locked recurring price in minor units - renewals must match PayPal, not current variant price. */
  locked_amount: model.number(),
  currency_code: model.text(),
  interval_unit: model.text(),
  interval_count: model.number(),
  first_sale_id: model.text().nullable(),
  next_billing_at: model.dateTime().nullable(),
  last_billing_at: model.dateTime().nullable(),
  failure_count: model.number().default(0),
  sales: model.json().nullable(),
  refunds: model.json().nullable(),
  metadata: model.json().nullable(),
});

export default PaypalSubscription;
