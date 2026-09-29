import { model } from "@medusajs/framework/utils";

/**
 * Singleton row of admin-managed overrides. Every override column is nullable
 * on purpose: NULL means "inherit from the config layers" (payment provider
 * options, then plugin options), so an unset column never masks a value the
 * merchant put in medusa-config. `version` is the only always-present value
 * and doubles as the cache key consumers watch to hot-reload their clients.
 */
const PaypalSettings = model.define("PaypalSettings", {
  id: model.id({ prefix: "ppset" }).primaryKey(),
  client_id: model.text().nullable(),
  client_secret: model.text().nullable(),
  is_sandbox: model.boolean().nullable(),
  webhook_id: model.text().nullable(),
  subscription_webhook_id: model.text().nullable(),
  include_shipping_data: model.boolean().nullable(),
  include_customer_data: model.boolean().nullable(),
  auto_bill_outstanding: model.boolean().nullable(),
  payment_failure_threshold: model.number().nullable(),
  version: model.number().default(1),
  last_modified_by: model.text().nullable(),
  last_modified_at: model.dateTime().nullable(),
  last_verified_at: model.dateTime().nullable(),
  last_verified_ok: model.boolean().nullable(),
});

export default PaypalSettings;
