import { model } from "@medusajs/framework/utils";

/**
 * Field-level trail of settings writes: `changed_fields` maps each touched
 * field to its `{ from, to }` pair. Secret fields are masked before they reach
 * this row - the raw value only ever lives in the settings row itself.
 */
const PaypalSettingsAudit = model.define("PaypalSettingsAudit", {
  id: model.id({ prefix: "ppsaud" }).primaryKey(),
  actor_id: model.text().nullable(),
  changed_fields: model.json(),
});

export default PaypalSettingsAudit;
