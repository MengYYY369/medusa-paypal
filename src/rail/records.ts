import {
  parseSubscriptionMetadata,
  type PaypalSubscriptionDeclaration,
} from "../subscription/metadata";
import type {
  NativeDeclaration,
  NativeSubscriptionChangedPayload,
  NativeSubscriptionRecord,
  NativeSubscriptionTransition,
  RailStatus,
} from "./types";

/**
 * This package's rail kind. One definition, used by the descriptor's `kind`
 * and by every payload this provider hands to the host's hook — the payload's
 * `kind` is what a consumer joins on, because a provider cannot know the
 * payment module's registration key it was mounted under.
 */
export const PAYPAL_RAIL_KIND = "paypal";

/**
 * PayPal's own lifecycle state → the rail-neutral vocabulary.
 *
 * `past_due` is deliberately absent: a failed charge does not change the row
 * (PayPal keeps it ACTIVE and the suspension arrives later as its own webhook),
 * so `past_due` is a synthesis made at the failing transition, not a state this
 * mapping can observe. An unrecognised state maps to `null`, which means "do
 * not mirror" — inventing `active` for a state nobody has seen is worse than
 * saying nothing.
 */
export function toRailStatus(
  status: string | null | undefined,
): RailStatus | null {
  switch (status) {
    case "ACTIVE":
      return "active";
    case "SUSPENDED":
      return "paused";
    case "CANCELLED":
    case "EXPIRED":
      return "cancelled";
    case "APPROVAL_PENDING":
      return null;
    default:
      return null;
  }
}

/** `Date | string | null` → ISO string, the only form the bus round-trips. */
export function toIsoString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === "string") {
    const trimmed = value.trim();

    if (!trimmed) {
      return null;
    }

    const parsed = new Date(trimmed);

    return Number.isNaN(parsed.getTime()) ? trimmed : parsed.toISOString();
  }

  return null;
}

/** One `paypal_subscription` row → the rail record a consumer mirrors. */
export function toNativeSubscriptionRecord(row: any): NativeSubscriptionRecord {
  return {
    provider_subscription_id: String(row?.paypal_subscription_id ?? "").trim(),
    plan_id: row?.paypal_plan_id ?? null,
    status: toRailStatus(row?.status),
    customer_id: row?.customer_id ?? null,
    variant_id: row?.variant_id ?? null,
    interval_unit: String(row?.interval_unit ?? ""),
    interval_count: Number(row?.interval_count ?? 0),
    next_billing_at: toIsoString(row?.next_billing_at),
    last_billing_at: toIsoString(row?.last_billing_at),
  };
}

/**
 * The payload for the host's hook: the complete record plus which transition
 * it is.
 *
 * `status` and the billing timestamps are overridable because the interesting
 * transitions disagree with the stored row: a successful renewals charge moves
 * `last_billing_at` while the row's status was already ACTIVE (if the caller
 * had not passed the new timestamp, a consumer could not tell a charge from a
 * status refresh), and a failed charge leaves the row ACTIVE while the rail
 * meaning is `past_due`.
 */
export function toNativeSubscriptionChangedPayload(input: {
  row: any;
  status: RailStatus | null;
  transition: NativeSubscriptionTransition;
  providerId?: string | null;
  lastBillingAt?: unknown;
  nextBillingAt?: unknown;
}): NativeSubscriptionChangedPayload {
  const record = toNativeSubscriptionRecord(input.row);

  return {
    ...record,
    status: input.status,
    next_billing_at:
      input.nextBillingAt === undefined
        ? record.next_billing_at
        : toIsoString(input.nextBillingAt),
    last_billing_at:
      input.lastBillingAt === undefined
        ? record.last_billing_at
        : toIsoString(input.lastBillingAt),
    kind: PAYPAL_RAIL_KIND,
    provider_id: input.providerId ?? input.row?.provider_id ?? null,
    transition: input.transition,
  };
}

const UNIT_LABELS: Record<string, { one: string; many: string }> = {
  DAY: { one: "day", many: "days" },
  WEEK: { one: "week", many: "weeks" },
  MONTH: { one: "month", many: "months" },
  YEAR: { one: "year", many: "years" },
};

/** `MONTH` + 3 → "3 months" (the admin renders these values verbatim). */
export function formatBillingInterval(
  unit: string,
  count: number,
): string | null {
  const label = UNIT_LABELS[unit];

  if (!label) {
    return null;
  }

  return `${count} ${count === 1 ? label.one : label.many}`;
}

/**
 * The merchant's variant declaration → the read-only rows the admin card
 * shows, with this provider's fallback wording.
 *
 * A malformed declaration answers `null` instead of throwing: the admin lists
 * every variant of a product, and one broken variant must not blank the card.
 * (Checkout still refuses the same variant with a merchant-actionable error —
 * that validation belongs to the plan-minting path, not to this read.)
 */
export function toNativeDeclaration(
  metadata: Record<string, unknown> | null,
): NativeDeclaration | null {
  let declaration: PaypalSubscriptionDeclaration | null = null;

  try {
    declaration = parseSubscriptionMetadata(metadata);
  } catch {
    return null;
  }

  if (!declaration) {
    return null;
  }

  const trial = declaration.trial_periods?.[0];
  const trialValue = trial
    ? (() => {
        const label = formatBillingInterval(trial.unit, trial.count);

        if (!label) {
          return null;
        }

        return trial.price > 0 ? `${label} at ${trial.price}` : `${label} free`;
      })()
    : null;

  return {
    fields: [
      {
        key: "interval",
        label: "Billing interval",
        value: formatBillingInterval(
          declaration.interval_unit,
          declaration.interval_count,
        ),
      },
      {
        key: "trial_period",
        label: "Trial period",
        value: trialValue,
      },
      {
        key: "setup_fee",
        label: "Setup fee (checkout currency)",
        value:
          declaration.setup_fee === undefined
            ? null
            : String(declaration.setup_fee),
      },
      {
        key: "product_type",
        label: "Product type",
        value: declaration.product_type,
      },
    ],
  };
}
