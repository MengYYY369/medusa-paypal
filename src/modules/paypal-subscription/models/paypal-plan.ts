import { model } from "@medusajs/framework/utils";

/**
 * Cache of one immutable PayPal billing plan: keyed by variant x currency,
 * versioned by a hash over the full pricing configuration. A price or
 * frequency edit mints a new row (and a new PayPal plan) while old rows keep
 * existing subscriptions untouched.
 */
const PaypalPlan = model.define("PaypalPlan", {
  id: model.id({ prefix: "ppplan" }).primaryKey(),
  variant_id: model.text().index("IDX_paypal_plan_variant"),
  currency_code: model.text(),
  paypal_product_id: model.text(),
  paypal_plan_id: model.text().unique(),
  config_hash: model.text().index("IDX_paypal_plan_hash"),
  status: model.text().default("ACTIVE"),
  metadata: model.json().nullable(),
});

export default PaypalPlan;
