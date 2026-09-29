import { z } from "zod";
import { createHash } from "crypto";
import { MedusaError } from "@medusajs/framework/utils";

export const PAYPAL_SUBSCRIPTION_METADATA_KEY = "paypal_subscription";

const billingUnitSchema = z.enum(["DAY", "WEEK", "MONTH", "YEAR"]);

/**
 * Money amounts are major units carrying at most the currency's own fraction
 * digits (usd -> 9.99, jpy -> 100, kwd -> 9.999). A variant declaration is
 * currency-agnostic, so the only ceiling enforceable here is ISO 4217's
 * maximum of 3 digits; the exact per-currency precision is applied against the
 * currency's `decimal_digits` when the amount is formatted for PayPal.
 * Counts and intervals are NOT money and stay integers.
 */
const moneyAmountSchema = z.number().finite().min(0).multipleOf(0.001);

const trialPeriodSchema = z.object({
  unit: billingUnitSchema,
  count: z.number().int().positive(),
  /**
   * Major-unit price charged for the trial period (0 = free trial).
   */
  price: moneyAmountSchema,
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
  setup_fee: moneyAmountSchema.optional(),
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
  /** Major-unit recurring price for a specific currency, resolved at plan time. */
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
 * recurring amount, currency, frequency, trial periods, setup fee and the
 * PayPal environment. A price edit mints a new plan version while leaving old
 * subscriptions on their existing plan; the environment is part of the
 * material because a plan minted in sandbox is not chargeable in live.
 */
export function planConfigHash(
  config: PaypalSubscriptionConfig,
  environment: "sandbox" | "live"
): string {
  const material = JSON.stringify({
    amount: config.amount,
    currency_code: config.currency_code,
    interval_unit: config.interval_unit,
    interval_count: config.interval_count,
    trial_periods: config.trial_periods ?? null,
    setup_fee: config.setup_fee ?? null,
    environment,
  });

  return createHash("sha256").update(material).digest("hex");
}
