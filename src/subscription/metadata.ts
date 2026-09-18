import { z } from "zod";
import { createHash } from "crypto";
import { MedusaError } from "@medusajs/framework/utils";

export const PAYPAL_SUBSCRIPTION_METADATA_KEY = "paypal_subscription";

const billingUnitSchema = z.enum(["DAY", "WEEK", "MONTH", "YEAR"]);

const trialPeriodSchema = z.object({
  unit: billingUnitSchema,
  count: z.number().int().positive(),
  /**
   * Minor-unit price charged for the trial period (0 = free trial).
   */
  price: z.number().int().min(0),
});

/**
 * Merchant-facing contract: a variant opts into PayPal Subscriptions by
 * carrying this object under metadata key `paypal_subscription`. Price is
 * deliberately NOT declared here - it is read from the variant's live price
 * for the checkout currency (see spec "商品声明").
 */
export const paypalSubscriptionMetadataSchema = z.object({
  interval_unit: billingUnitSchema,
  interval_count: z.number().int().positive().default(1),
  trial_periods: z.array(trialPeriodSchema).max(1).optional(),
  setup_fee: z.number().int().min(0).optional(),
  product_type: z.enum(["SERVICE", "PHYSICAL", "DIGITAL"]).default("SERVICE"),
  product_name: z.string().min(1).optional(),
});

export type PaypalSubscriptionMetadata = z.input<
  typeof paypalSubscriptionMetadataSchema
>;
/** Validated declaration as written on the variant metadata. */
export type PaypalSubscriptionDeclaration = z.output<
  typeof paypalSubscriptionMetadataSchema
>;
/** Declaration enriched with the variant price for a specific currency. */
export type PaypalSubscriptionConfig = PaypalSubscriptionDeclaration & {
  /** Minor-unit recurring price for a specific currency, resolved at plan time. */
  amount: number;
  currency_code: string;
};

/**
 * Reads and validates the subscription declaration off a variant's metadata.
 * Returns null for variants without the key (normal checkout), and throws a
 * MedusaError with a merchant-actionable message for malformed declarations
 * so misconfigurations surface at checkout instead of failing inside PayPal.
 */
export function parseSubscriptionMetadata(
  metadata: Record<string, unknown> | null | undefined
): PaypalSubscriptionDeclaration | null {
  const raw = metadata?.[PAYPAL_SUBSCRIPTION_METADATA_KEY];

  if (raw === undefined || raw === null) {
    return null;
  }

  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Variant metadata "${PAYPAL_SUBSCRIPTION_METADATA_KEY}" is not valid JSON: ${raw}`
      );
    }
  }

  const parsed = paypalSubscriptionMetadataSchema.safeParse(value);

  if (!parsed.success) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Invalid "${PAYPAL_SUBSCRIPTION_METADATA_KEY}" metadata: ${parsed.error.message}`
    );
  }

  return parsed.data;
}

/**
 * Stable hash over everything that forces a new immutable PayPal plan:
 * recurring amount, currency, frequency, trial periods and setup fee.
 * A price edit therefore mints a new plan version while leaving old
 * subscriptions on their existing plan.
 */
export function planConfigHash(config: PaypalSubscriptionConfig): string {
  const material = JSON.stringify({
    amount: config.amount,
    currency_code: config.currency_code,
    interval_unit: config.interval_unit,
    interval_count: config.interval_count,
    trial_periods: config.trial_periods ?? null,
    setup_fee: config.setup_fee ?? null,
  });

  return createHash("sha256").update(material).digest("hex");
}
