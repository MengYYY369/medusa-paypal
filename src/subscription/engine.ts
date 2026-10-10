import { MedusaError } from "@medusajs/framework/utils";
import { Logger, WebhookActionResult } from "@medusajs/framework/types";
import {
  PaypalService,
  PaypalBillingCycleInput,
  PaypalSubscriptionResponse,
  extractApproveUrl,
  formatPaypalAmount,
} from "../providers/paypal/paypal-core/paypal-core";
import { getPaypalFractionDigits } from "../lib/currency-digits";
import {
  parseSubscriptionMetadata,
  planConfigHash,
  PaypalSubscriptionConfig,
  PaypalSubscriptionDeclaration,
} from "./metadata";
import {
  toNativeSubscriptionChangedPayload,
  toRailStatus,
} from "../rail/records";
import type {
  NativeSubscriptionChangedHook,
  NativeSubscriptionTransition,
  RailStatus,
} from "../rail/types";
import {
  PaypalSubscriptionStatus,
  SubscriptionRefundRecord,
  SubscriptionSaleRecord,
} from "./types";

type EventBusLike = { emit: (data: unknown) => Promise<unknown> };

/**
 * The subset of the paypal_subscription module service the engine relies on.
 * The real module service satisfies it; tests plug an in-memory fake, keeping
 * the single test seam at the engine/provider boundary.
 */
export type SubscriptionModuleLike = {
  listPaypalPlans: (filters?: any, config?: any) => Promise<any[]>;
  createPaypalPlans: (data: any) => Promise<any>;
  listPaypalSubscriptions: (filters?: any, config?: any) => Promise<any[]>;
  listAndCountPaypalSubscriptions?: (
    filters?: any,
    config?: any
  ) => Promise<[any[], number]>;
  createPaypalSubscriptions: (data: any) => Promise<any>;
  retrievePaypalSubscription: (id: string, config?: any) => Promise<any>;
  updatePaypalSubscriptions: (data: any) => Promise<any>;
};

/**
 * Cross-module collaborators, resolved differently per caller: the payment
 * provider pulls them from its cradle (merchant `dependencies` config),
 * routes/jobs resolve them from the root container and pass them through the
 * module service. Anything optional that is missing surfaces as a clear
 * configuration error only when the feature that needs it runs.
 */
export type SubscriptionEngineModules = {
  query?: any;
  productModule?: any;
  orderModule?: any;
  paymentModule?: any;
  /** Workflow engine, only used by the reconciliation job to replay the standard payment workflow. */
  workflowEngine?: any;
};

export type SubscriptionEngineOptions = {
  autoBillOutstanding?: boolean;
  paymentFailureThreshold?: number;
  /**
   * The rail-event sink the host injects (`onNativeSubscriptionChanged` in
   * this plugin's options). The engine hands it the complete record of every
   * transition; it knows no event name, because the name, the payload shape
   * and the publication all belong to `medusa-payment-methods`.
   *
   * Absent in a host that did not wire it: the transitions then publish
   * nothing, which the module service warns about once at boot.
   */
  onNativeSubscriptionChanged?: NativeSubscriptionChangedHook;
};

export type SubscriptionEngineDeps = SubscriptionEngineModules & {
  client: PaypalService;
  logger: Logger;
  eventBus: EventBusLike;
  subscriptionModule: SubscriptionModuleLike;
  options?: SubscriptionEngineOptions;
};

type SubscriptionRow = {
  id: string;
  paypal_subscription_id: string;
  paypal_plan_id?: string | null;
  variant_id: string;
  customer_id?: string | null;
  payment_session_id: string;
  payment_collection_id?: string | null;
  provider_id?: string | null;
  status: PaypalSubscriptionStatus | string;
  locked_amount: number;
  currency_code: string;
  interval_unit: string;
  interval_count: number;
  first_sale_id?: string | null;
  next_billing_at?: Date | string | null;
  last_billing_at?: Date | string | null;
  failure_count?: number;
  sales: SubscriptionSaleRecord[];
  refunds: SubscriptionRefundRecord[];
  metadata?: Record<string, unknown> | null;
};

/**
 * Outcome of a customer-initiated plan switch. PayPal treats a revise as a
 * consent request, so the usual answer is `pending: true`: nothing local has
 * moved yet, the caller has to send the buyer to `approvalUrl`, and the switch
 * lands on the row when PayPal confirms it (BILLING.SUBSCRIPTION.UPDATED
 * webhook, or the nightly reconciliation pass). `pending: false` means the
 * switch needed no consent and the row already moved.
 */
export type CustomerReviseResult = {
  subscription: SubscriptionRow;
  approvalUrl: string | null;
  pending: boolean;
};

/** Webhook event types that belong to the subscription rail. */
export function isSubscriptionEvent(eventType: string): boolean {
  return (
    eventType.startsWith("BILLING.SUBSCRIPTION.") ||
    eventType.startsWith("PAYMENT.SALE.")
  );
}

/**
 * Variant listing across product module versions: 2.20+ exposes
 * `listProductVariants` (older builds used `listVariants`). Only entity data
 * (metadata, titles) is needed here - variant prices live in the pricing
 * module since 2.x and are NOT a product-module entity relation, so the
 * recurring amount always comes from the payment session, never from this
 * listing.
 */
async function listVariantsByIds(
  productModule: any,
  variantIds: string[]
): Promise<any[]> {
  const list = productModule.listProductVariants ?? productModule.listVariants;

  if (typeof list !== "function") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "The product module dependency does not expose a variant listing method."
    );
  }

  return (
    (await list.call(productModule, { id: variantIds }, {
      take: variantIds.length,
    })) ?? []
  );
}

/**
 * MedusaService returns a single entity for object input and an array for
 * array input - unit fakes and the real module may disagree on the shape,
 * so callers normalize instead of assuming.
 */
function firstOrSelf<T>(result: T | T[]): T {
  return Array.isArray(result) ? (result[0] as T) : (result as T);
}

/**
 * Webhook sale/capture resources mix the legacy v1 sale shape
 * (amount.total / amount.currency) with the payments-v2 shape
 * (amount.value / amount.currency_code) - normalize to the major units Medusa
 * stores, i.e. take PayPal's decimal string as-is.
 */
function webhookAmount(resource: any): { amount: number; currency?: string } {
  const value =
    resource?.amount?.total ??
    resource?.amount?.value ??
    resource?.amount_with_breakdown?.gross_amount?.value;
  const currency =
    resource?.amount?.currency ??
    resource?.amount?.currency_code ??
    resource?.amount_with_breakdown?.gross_amount?.currency_code;

  return { amount: Number(value ?? 0), currency };
}

function paymentModuleAvailable(deps: SubscriptionEngineDeps): boolean {
  return !!(deps as Record<string, any>).paymentModule;
}

export class SubscriptionEngine {
  constructor(protected deps: SubscriptionEngineDeps) {}

  /**
   * Returns a copy of the engine with per-call module overrides merged in -
   * how routes/jobs (root container) and the provider (cradle) contribute
   * their own collaborators to the same implementation.
   */
  for(overrides: SubscriptionEngineModules): SubscriptionEngine {
    return new SubscriptionEngine({ ...this.deps, ...overrides });
  }

  private require(name: string, feature: string): any {
    const module = (this.deps as Record<string, any>)[name];

    if (!module) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `PayPal subscriptions require the "${name}" to be available. Add ["paypalSubscription", "order", "product", "query"] to the payment module "dependencies" in medusa-config (missing: ${name}) to enable ${feature}.`
      );
    }

    return module;
  }

  // -------------------------------------------------------------------------
  // Plan management
  // -------------------------------------------------------------------------

  /**
   * Fetches a variant with its subscription declaration and the live variant
   * price for a currency. Prices are read through the query graph (pricing
   * module link) because they are not a product-module entity relation.
   */
  async resolveSubscriptionVariant(
    variantId: string,
    currencyCode: string
  ): Promise<{ variant: any; declaration: PaypalSubscriptionDeclaration; amount: number } | null> {
    const query = this.require("query", "plan pricing");
    const productModule = this.require("productModule", "plan resolution");

    const variants = await listVariantsByIds(productModule, [variantId]);

    const variant = variants?.[0];

    if (!variant) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Variant ${variantId} not found`
      );
    }

    const declaration = parseSubscriptionMetadata(variant.metadata);

    if (!declaration) {
      return null;
    }

    const graph = await query.graph({
      entity: "variant",
      fields: ["id", "prices.amount", "prices.currency_code"],
      filters: { id: [variantId] },
    });

    const priced = (graph?.data ?? []).find((v: any) => v?.id === variantId);
    const price = (priced?.prices ?? []).find(
      (p: any) => p.currency_code === currencyCode
    );

    if (!price) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Subscription variant ${variantId} has no price for currency ${currencyCode}`
      );
    }

    return {
      variant,
      declaration,
      amount: Number(price.amount),
    };
  }

  /**
   * Detects whether a payment session's items form a valid subscription
   * checkout: exactly one subscription variant, quantity 1, no regular items.
   * Mixed carts throw with guidance to split the order. Silently returns
   * false when the product module is unavailable - installs without the
   * dependencies opt-in keep their pre-subscription checkout behavior.
   */
  async detectSubscriptionSession(items: any[] | undefined): Promise<{
    subscription: boolean;
    variant?: any;
  }> {
    if (!items?.length || !this.deps.productModule) {
      return { subscription: false };
    }

    const productModule = this.deps.productModule;
    const variantIds = [
      ...new Set(items.map((item) => item.variant_id).filter(Boolean)),
    ];

    if (!variantIds.length) {
      return { subscription: false };
    }

    const variants = await listVariantsByIds(productModule, variantIds);

    const subscriptionVariants: { variant: any; config: any }[] = [];

    for (const variant of variants ?? []) {
      const config = parseSubscriptionMetadata(variant.metadata);

      if (config) {
        subscriptionVariants.push({ variant, config });
      }
    }

    if (!subscriptionVariants.length) {
      return { subscription: false };
    }

    const subscriptionVariantIds = new Set(
      subscriptionVariants.map(({ variant }) => variant.id)
    );
    const hasRegularItems = (items ?? []).some(
      (item) => item.variant_id && !subscriptionVariantIds.has(item.variant_id)
    );

    if (hasRegularItems || variantIds.length !== subscriptionVariants.length) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Subscription items cannot be combined with regular items. Please place subscription orders separately."
      );
    }

    if (subscriptionVariants.length > 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Multiple different subscription items are not supported in one order. Please place one subscription per order."
      );
    }

    const totalQuantity = (items ?? []).reduce(
      (sum, item) => sum + (Number(item.quantity) || 0),
      0
    );

    if (totalQuantity !== 1) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "A subscription can only be purchased with a quantity of 1."
      );
    }

    return { subscription: true, variant: subscriptionVariants[0].variant };
  }

  /**
   * R5: one live subscription per customer per product.
   *
   * A second live subscription for the same product is almost always a
   * double-billing accident - the customer forgot they were already
   * subscribed, or abandoned an approval and started over - so checkout
   * refuses it and names the two legitimate ways forward: cancel it, or switch
   * plans. The error carries the `SUBSCRIPTION_ALREADY_ACTIVE` code so the
   * storefront can route the customer into the switch flow instead of
   * rendering a dead end.
   *
   * Only ACTIVE and SUSPENDED rows block. An APPROVAL_PENDING row is an
   * abandoned checkout, and blocking on it would trap a customer behind a
   * subscription they never approved (PayPal expires those on its own);
   * CANCELLED and EXPIRED rows are history. A guest checkout has no customer
   * to key on and is left alone - this is a data-level guard against a second
   * subscription, not an identity check.
   */
  async assertNoConflictingSubscription({
    customerId,
    variantId,
  }: {
    customerId?: string | null;
    variantId: string;
  }): Promise<void> {
    if (!customerId || !variantId) {
      return;
    }

    const productModule = this.require(
      "productModule",
      "subscription conflict check"
    );

    const targetVariants = await listVariantsByIds(productModule, [variantId]);
    const targetProductId = targetVariants?.[0]?.product_id;

    if (!targetProductId) {
      return;
    }

    const liveRows = (await this.deps.subscriptionModule.listPaypalSubscriptions({
      customer_id: customerId,
      status: ["ACTIVE", "SUSPENDED"],
    })) as SubscriptionRow[];

    const liveVariantIds = [
      ...new Set(liveRows.map((row) => row.variant_id).filter(Boolean)),
    ];

    if (!liveVariantIds.length) {
      return;
    }

    const liveVariants = await listVariantsByIds(productModule, liveVariantIds);

    const conflicting = liveRows.find((row) => {
      const variant = (liveVariants ?? []).find(
        (candidate) => candidate.id === row.variant_id
      );

      return variant?.product_id === targetProductId;
    });

    if (!conflicting) {
      return;
    }

    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `You already have an active subscription for ${await this.productNameFor(
        productModule,
        targetProductId
      )}. Cancel it first, or switch to another plan from your subscriptions page.`,
      "SUBSCRIPTION_ALREADY_ACTIVE"
    );
  }

  /** Product title for a refusal message; the id is a poor thing to show a customer. */
  private async productNameFor(
    productModule: any,
    productId: string
  ): Promise<string> {
    try {
      const product = await productModule.retrieveProduct(productId);

      return product?.title ?? "this product";
    } catch {
      return "this product";
    }
  }

  /**
   * Gets the cached PayPal plan for variant x currency x config hash, or
   * creates the PayPal product + plan (plan immutable -> new version per
   * hash) and caches the row.
   */
  async ensurePlan({
    variant,
    config,
    currencyCode,
    amount,
  }: {
    variant: any;
    config: PaypalSubscriptionDeclaration;
    currencyCode: string;
    /** Major-unit recurring price for the checkout currency. */
    amount: number;
  }): Promise<{ planRow: any; config: PaypalSubscriptionConfig }> {
    const { client } = this.deps;
    const subscriptionModule = this.deps.subscriptionModule;

    const fullConfig: PaypalSubscriptionConfig = {
      ...config,
      amount,
      currency_code: currencyCode,
    };

    const hash = planConfigHash(fullConfig, client.environment);

    const existing = await subscriptionModule.listPaypalPlans({
      variant_id: variant.id,
      currency_code: currencyCode,
      config_hash: hash,
    });

    if (existing.length) {
      return { planRow: existing[0], config: fullConfig };
    }

    // Products are reusable across currencies and plan versions.
    const priorPlans = await subscriptionModule.listPaypalPlans({
      variant_id: variant.id,
    });

    let productId = priorPlans[0]?.paypal_product_id;

    if (!productId) {
      const product = await client.createBillingProduct({
        name: fullConfig.product_name ?? variant.title ?? "Subscription",
        type: fullConfig.product_type,
      });

      productId = product.id;
    }

    const cycles = await this.buildBillingCycles(
      fullConfig,
      await getPaypalFractionDigits(this.deps.query, currencyCode, this.deps.logger)
    );

    const plan = await client.createBillingPlan({
      product_id: productId,
      name: `${variant.title ?? "Subscription"} (${currencyCode})`,
      billing_cycles: cycles,
      auto_bill_outstanding: this.deps.options?.autoBillOutstanding ?? true,
      payment_failure_threshold:
        this.deps.options?.paymentFailureThreshold ?? 3,
    });

    const createdPlan = await subscriptionModule.createPaypalPlans({
      variant_id: variant.id,
      currency_code: currencyCode,
      paypal_product_id: productId,
      paypal_plan_id: plan.id,
      config_hash: hash,
      status: "ACTIVE",
    });

    const planRow = firstOrSelf(createdPlan);

    return { planRow, config: fullConfig };
  }

  private async buildBillingCycles(
    config: PaypalSubscriptionConfig,
    fractionDigits: number
  ): Promise<PaypalBillingCycleInput[]> {
    const currency = config.currency_code;
    const cycles: PaypalBillingCycleInput[] = [];
    const trial = config.trial_periods?.[0];
    let sequence = 1;

    if (trial) {
      cycles.push({
        frequency: {
          interval_unit: trial.unit,
          interval_count: trial.count,
        },
        tenure_type: "TRIAL",
        sequence: sequence++,
        total_cycles: 1,
        pricing_scheme: {
          fixed_price: {
            value: formatPaypalAmount(trial.price, fractionDigits),
            currency_code: currency,
          },
        },
        ...(config.setup_fee != null && {
          billing_preferences: {
            setup_fee: {
              value: formatPaypalAmount(config.setup_fee, fractionDigits),
              currency_code: currency,
            },
          },
        }),
      });
    }

    cycles.push({
      frequency: {
        interval_unit: config.interval_unit,
        interval_count: config.interval_count,
      },
      tenure_type: "REGULAR",
      sequence: sequence++,
      total_cycles: 0,
      pricing_scheme: {
        fixed_price: {
          value: formatPaypalAmount(config.amount, fractionDigits),
          currency_code: currency,
        },
      },
      ...(!trial &&
        config.setup_fee != null && {
          billing_preferences: {
            setup_fee: {
              value: formatPaypalAmount(config.setup_fee, fractionDigits),
              currency_code: currency,
            },
          },
        }),
    });

    return cycles;
  }

  // -------------------------------------------------------------------------
  // First purchase (session initiation + authorization)
  // -------------------------------------------------------------------------

  /**
   * The customer a subscription belongs to.
   *
   * The Buttons route reads the owner straight off the cart and passes it in.
   * The redirect flow cannot: it reaches the engine from the payment provider,
   * which only sees the payment session, and hosts reserve `customer_id` in
   * the session data as a *vault* signal - so a subscription checkout arrives
   * without it. Two sources are tried, cheapest first: the session context
   * Medusa fills from the cart (always present in a checkout), then the cart
   * link behind the session. Either keeps the row's owner intact, which is
   * what the customer's own subscriptions page, the cancel/revise ownership
   * checks and the one-live-subscription guard all key on. A guest checkout
   * (cart without a customer) stays NULL.
   */
  private async resolveCustomerIdForSession({
    sessionId,
    customerId,
  }: {
    sessionId: string;
    customerId?: string | null;
  }): Promise<string | null> {
    if (customerId) {
      return customerId;
    }

    const query = (this.deps as Record<string, any>).query;
    const paymentModule = this.deps.paymentModule;

    if (!paymentModule?.retrievePaymentSession) {
      return null;
    }

    try {
      const session = await paymentModule.retrievePaymentSession(sessionId);
      const paymentCollectionId = session?.payment_collection_id;

      /**
       * Medusa fills the payment session context from the cart, so the
       * customer rides along with the session itself. This is the source that
       * works everywhere: the payment provider's cradle carries no `query`
       * (only the module keys listed in the host's `dependencies`), so the
       * link lookup below never runs inside a checkout - it serves the
       * reconciliation job and any caller wired with the root container.
       */
      const contextCustomerId = (session as any)?.context?.customer?.id;

      if (typeof contextCustomerId === "string" && contextCustomerId) {
        return contextCustomerId;
      }

      if (!query?.graph || !paymentCollectionId) {
        return null;
      }

      const links = await query.graph({
        entity: "cart_payment_collection",
        filters: { payment_collection_id: paymentCollectionId },
        fields: ["cart_id"],
      });

      const cartId = links?.data?.[0]?.cart_id;

      if (!cartId) {
        return null;
      }

      const carts = await query.graph({
        entity: "cart",
        filters: { id: cartId },
        fields: ["customer_id"],
      });

      const resolved = carts?.data?.[0]?.customer_id;

      return typeof resolved === "string" && resolved ? resolved : null;
    } catch (error) {
      this.deps.logger?.warn?.(
        `Could not resolve the customer behind subscription session ${sessionId}: ${String(error)}`
      );

      return null;
    }
  }

  /**
   * Creates the PayPal subscription for a payment session (idempotent per
   * session - the Buttons route and the initiate branch converge here) and
   * records the APPROVAL_PENDING row.
   */
  async initiateSubscriptionSession({
    sessionId,
    variantId,
    currencyCode,
    amount,
    email,
    customerId,
    returnUrl,
    cancelUrl,
  }: {
    sessionId: string;
    variantId: string;
    currencyCode: string;
    /** Major-unit recurring price from the payment session (source of truth). */
    amount: number;
    email?: string;
    customerId?: string;
    returnUrl?: string;
    cancelUrl?: string;
  }): Promise<{
    row: SubscriptionRow;
    paypalSubscriptionId: string;
    approveLink?: string;
  }> {
    const { client, subscriptionModule } = this.deps;

    const existing = await subscriptionModule.listPaypalSubscriptions({
      payment_session_id: sessionId,
    });

    if (existing.length) {
      const row = existing[0] as SubscriptionRow;

      return {
        row,
        paypalSubscriptionId: row.paypal_subscription_id,
        approveLink: (row.metadata as any)?.approve_link,
      };
    }

    const productModule = this.require("productModule", "checkout");
    const variants = await listVariantsByIds(productModule, [variantId]);
    const variant = variants?.[0];

    if (!variant) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Variant ${variantId} not found`
      );
    }

    const declaration = parseSubscriptionMetadata(variant.metadata);

    if (!declaration) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Variant ${variantId} is not a subscription variant`
      );
    }

    const resolvedCustomerId = await this.resolveCustomerIdForSession({
      sessionId,
      customerId,
    });

    // R5 belongs here as well as on the Buttons route: the redirect flow
    // creates its PayPal subscription during initiatePayment, where that
    // route never runs, so without this the guard is dead on the path the
    // storefront actually uses.
    await this.assertNoConflictingSubscription({
      customerId: resolvedCustomerId,
      variantId,
    });

    const { planRow, config } = await this.ensurePlan({
      variant,
      config: declaration,
      currencyCode,
      amount,
    });

    const subscription = await client.createSubscription({
      plan_id: planRow.paypal_plan_id,
      custom_id: sessionId,
      ...(email && { email }),
      ...(returnUrl && { return_url: returnUrl }),
      ...(cancelUrl && { cancel_url: cancelUrl }),
    });

    const approveLink = extractApproveUrl(subscription.links);

    const paymentModule = this.deps.paymentModule;
    let providerId: string | null = null;
    let paymentCollectionId: string | null = null;

    if (paymentModule) {
      try {
        const session = await paymentModule.retrievePaymentSession(sessionId);

        providerId = session?.provider_id ?? null;
        paymentCollectionId = session?.payment_collection_id ?? null;
      } catch (error) {
        this.deps.logger.warn(
          `Could not enrich subscription row from session ${sessionId}: ${String(error)}`
        );
      }
    }

    const createdRow = await subscriptionModule.createPaypalSubscriptions({
      paypal_subscription_id: subscription.id,
      paypal_plan_id: planRow.paypal_plan_id,
      variant_id: variantId,
      customer_id: resolvedCustomerId,
      payment_session_id: sessionId,
      payment_collection_id: paymentCollectionId,
      provider_id: providerId,
      status: "APPROVAL_PENDING",
      locked_amount: config.amount,
      currency_code: currencyCode,
      interval_unit: config.interval_unit,
      interval_count: config.interval_count,
      sales: [],
      refunds: [],
      metadata: { approve_link: approveLink ?? null },
    });

    const row = firstOrSelf(createdRow);

    return { row: row as SubscriptionRow, paypalSubscriptionId: subscription.id, approveLink };
  }

  /**
   * Cart-completion support: a subscription session authorizes once the
   * subscription is ACTIVE locally, falling back to a single PayPal re-query
   * when the ACTIVATED webhook has not landed yet.
   */
  async authorizeSubscriptionSession({
    sessionData,
  }: {
    sessionData: Record<string, unknown>;
  }): Promise<{ status: "authorized" | "pending"; data: Record<string, unknown> }> {
    const { client } = this.deps;
    const subscriptionModule = this.require(
      "subscriptionModule",
      "subscription authorization"
    );

    const row = await this.findRowBySessionData(sessionData);

    if (!row) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "PayPal subscription session has no subscription record"
      );
    }

    if (row.status === "ACTIVE") {
      return { status: "authorized", data: sessionData };
    }

    const subscription = await client.getSubscription(row.paypal_subscription_id);

    if (subscription.status === "ACTIVE") {
      // The renewal date rides into the same write as the status change, so
      // the rail event carries it (rows that were already ACTIVE keep their
      // value; the daily reconciliation is what backfills those).
      const withBillingInfo = await this.backfillNextBillingAt(row, subscription);

      await this.transitionRow(withBillingInfo, "ACTIVE");

      return { status: "authorized", data: sessionData };
    }

    return {
      status: "pending",
      data: {
        ...sessionData,
        error: {
          code: "SUBSCRIPTION_NOT_ACTIVE",
          message: "PayPal subscription is not active yet. Approve the subscription to continue.",
          retryable: true,
        },
      },
    };
  }

  /**
   * Persists the renewal date PayPal reports for an activated subscription.
   *
   * `billing_info.next_billing_time` is absent while a subscription is still
   * APPROVAL_PENDING and on some freshly activated ones; a missing or
   * unparseable value leaves the column untouched (and warns) rather than
   * writing a bogus date - the host mirrors this column as the customer's next
   * charge day, so "unknown" beats "wrong".
   */
  private async backfillNextBillingAt(
    row: SubscriptionRow,
    subscription: PaypalSubscriptionResponse
  ): Promise<SubscriptionRow> {
    const raw = subscription?.billing_info?.next_billing_time;
    const parsed = raw ? new Date(raw) : null;
    const next = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

    if (!next) {
      this.deps.logger.warn(
        `PayPal reported no next billing time for subscription ${row.id} (${row.paypal_subscription_id}); next_billing_at left unset.`
      );

      return row;
    }

    const updated = firstOrSelf(
      await this.deps.subscriptionModule.updatePaypalSubscriptions({
        id: row.id,
        next_billing_at: next,
      })
    );

    return (updated as SubscriptionRow) ?? { ...row, next_billing_at: next };
  }

  private async findRowBySessionData(
    sessionData: Record<string, unknown>
  ): Promise<SubscriptionRow | null> {
    const { subscriptionModule } = this.deps;
    if (sessionData.paypal_subscription_id) {
      const rows = await subscriptionModule.listPaypalSubscriptions({
        paypal_subscription_id: sessionData.paypal_subscription_id,
      });

      if (rows.length) {
        return rows[0] as SubscriptionRow;
      }
    }

    if (sessionData.paypal_subscription_row_id) {
      try {
        const row = await subscriptionModule.retrievePaypalSubscription(
          String(sessionData.paypal_subscription_row_id)
        );

        return row as SubscriptionRow;
      } catch {
        return null;
      }
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Webhook handling
  // -------------------------------------------------------------------------

  /**
   * Subscription-class webhook events. Returns null for events outside the
   * subscription rail (caller falls through to the payment-event mapping) and
   * always returns not_supported for handled events - Medusa must not apply
   * session side effects to subscription state changes.
   */
  async handleWebhookEvent(
    eventType: string,
    resource: any
  ): Promise<WebhookActionResult | null> {
    if (!eventType.startsWith("BILLING.SUBSCRIPTION.")) {
      if (!eventType.startsWith("PAYMENT.SALE.")) {
        return null;
      }
    }

    switch (eventType) {
      case "BILLING.SUBSCRIPTION.ACTIVATED":
        await this.onSubscriptionActivated(resource, eventType);
        return { action: "not_supported" };
      case "BILLING.SUBSCRIPTION.RE-ACTIVATED":
        // Same shape as ACTIVATED - a suspended subscription PayPal switched
        // back on. Until 0.10.3 this fell through to `default` and the row sat
        // SUSPENDED until the nightly reconcile caught up.
        await this.onSubscriptionActivated(resource, eventType);
        return { action: "not_supported" };
      case "BILLING.SUBSCRIPTION.SUSPENDED":
        await this.syncSubscriptionStatus(resource?.id, "SUSPENDED");
        return { action: "not_supported" };
      case "BILLING.SUBSCRIPTION.CANCELLED":
        await this.syncSubscriptionStatus(resource?.id, "CANCELLED");
        return { action: "not_supported" };
      case "BILLING.SUBSCRIPTION.EXPIRED":
        await this.syncSubscriptionStatus(resource?.id, "EXPIRED");
        return { action: "not_supported" };
      case "BILLING.SUBSCRIPTION.UPDATED":
        await this.onSubscriptionUpdated(resource);
        return { action: "not_supported" };
      case "BILLING.SUBSCRIPTION.PAYMENT.FAILED":
      case "PAYMENT.SALE.DENIED":
      case "PAYMENT.SALE.DECLINED":
        await this.onSubscriptionPaymentFailed(eventType, resource);
        return { action: "not_supported" };
      case "PAYMENT.SALE.COMPLETED":
        return this.onSaleCompleted(resource);
      case "PAYMENT.SALE.REFUNDED":
      case "PAYMENT.SALE.REVERSED":
        await this.syncRefundFromPaypal(resource);
        return { action: "not_supported" };
      default:
        return { action: "not_supported" };
    }
  }

  private async findRowByPaypalId(
    paypalSubscriptionId: string | undefined
  ): Promise<SubscriptionRow | null> {
    if (!paypalSubscriptionId) {
      return null;
    }

    const rows = await this.deps.subscriptionModule.listPaypalSubscriptions({
      paypal_subscription_id: paypalSubscriptionId,
    });

    return rows[0] ?? null;
  }

  /**
   * ACTIVATED carries the whole subscription resource, so the renewal date is
   * read off the webhook itself - no extra PayPal call - and written together
   * with the status flip, which is what puts `next_billing_at` into the rail
   * event the host mirrors as the customer's next charge day.
   */
  private async onSubscriptionActivated(
    resource: any,
    eventType = "BILLING.SUBSCRIPTION.ACTIVATED"
  ): Promise<void> {
    const row = await this.findRowByPaypalId(resource?.id);

    if (!row) {
      this.deps.logger.warn(
        `${eventType} for unknown subscription ${resource?.id}; ignoring`
      );
      return;
    }

    if (row.status === "SUSPENDED") {
      const withBillingInfo = await this.backfillNextBillingAt(row, resource);

      await this.transitionRow(withBillingInfo, "ACTIVE", "status");
      return;
    }

    if (row.status !== "ACTIVE") {
      const withBillingInfo = await this.backfillNextBillingAt(row, resource);

      await this.transitionRow(withBillingInfo, "ACTIVE", "status");
    }
  }

  /**
   * A switch the buyer consented to lands here: UPDATED carries the
   * subscription resource with its **new** plan id, which is exactly what a
   * pending revise was waiting for. The renewal date is refreshed off the same
   * payload; a plan id this plugin does not know only warns (see
   * `applyPaypalPlanToRow`).
   */
  private async onSubscriptionUpdated(resource: any): Promise<void> {
    const row = await this.findRowByPaypalId(resource?.id);

    if (!row) {
      this.deps.logger.warn(
        `BILLING.SUBSCRIPTION.UPDATED for unknown subscription ${resource?.id}; ignoring`
      );
      return;
    }

    const withBillingInfo = await this.backfillNextBillingAt(row, resource);
    const paypalPlanId =
      typeof resource?.plan_id === "string" ? resource.plan_id : null;

    if (!paypalPlanId || paypalPlanId === withBillingInfo.paypal_plan_id) {
      return;
    }

    await this.applyPaypalPlanToRow(withBillingInfo, paypalPlanId);
  }

  /**
   * Inbound CANCELLED/SUSPENDED/EXPIRED sync. Only fires the event when the
   * status actually changes, so webhook + admin dual paths stay idempotent.
   */
  private async syncSubscriptionStatus(
    paypalSubscriptionId: string | undefined,
    status: PaypalSubscriptionStatus
  ): Promise<void> {
    const row = await this.findRowByPaypalId(paypalSubscriptionId);

    if (!row) {
      this.deps.logger.warn(
        `${status} webhook for unknown subscription ${paypalSubscriptionId}; ignoring`
      );
      return;
    }

    await this.transitionRow(row, status, "status");
  }

  private async onSubscriptionPaymentFailed(
    eventType: string,
    resource: any
  ): Promise<void> {
    const row = await this.findRowByPaypalId(
      resource?.billing_agreement_id ?? resource?.id
    );

    if (!row) {
      this.deps.logger.warn(
        `${eventType} for unknown subscription; ignoring`
      );
      return;
    }

    await this.deps.subscriptionModule.updatePaypalSubscriptions({
      id: row.id,
      failure_count: (row.failure_count ?? 0) + 1,
    });

    await this.notifyRailChange(row, "payment_failed", "past_due");
  }

  /**
   * First charge -> standard captured mechanism (Medusa marks the session
   * captured and completes the cart); later charges -> renewal orders.
   * Discrimination is by the row's first_sale_id, never by arrival order.
   */
  private async onSaleCompleted(resource: any): Promise<
    | { action: "not_supported" }
    | { action: "captured"; data: { session_id: string; amount: number } }
  > {
    const row = await this.findRowByPaypalId(resource?.billing_agreement_id);

    if (!row) {
      this.deps.logger.warn(
        `PAYMENT.SALE.COMPLETED without a known billing agreement ${resource?.billing_agreement_id}; ignoring`
      );
      return { action: "not_supported" };
    }

    const saleId = resource?.id;

    if (!saleId) {
      return { action: "not_supported" };
    }

    const sales = row.sales ?? [];

    if (sales.some((sale) => sale.sale_id === saleId)) {
      // Duplicate delivery - already recorded.
      return { action: "not_supported" };
    }

    const { amount, currency } = webhookAmount(resource);
    const currencyCode = currency ?? row.currency_code;
    const billedAt = resource?.time ?? resource?.create_time ?? new Date().toISOString();

    if (!row.first_sale_id) {
      await this.deps.subscriptionModule.updatePaypalSubscriptions({
        id: row.id,
        first_sale_id: saleId,
        last_billing_at: billedAt,
        failure_count: 0,
        sales: [
          ...sales,
          { sale_id: saleId, amount, currency_code: currencyCode, billed_at: billedAt } as SubscriptionSaleRecord,
        ],
      });

      await this.notifyRailChange(
        row,
        "payment_succeeded",
        // A completed charge proves the subscription is live, whatever the row
        // says (the row is ACTIVE by the time a charge lands; the fallback only
        // covers a row whose status is not mapped).
        toRailStatus(row.status) ?? "active",
        { lastBillingAt: billedAt }
      );

      // The standard captured mechanism marks the session captured and
      // completes the cart (or records the charge against the trial-end
      // order) - the same path as an ordinary PayPal capture webhook.
      return {
        action: "captured",
        data: { session_id: row.payment_session_id, amount },
      };
    }

    await this.createRenewalOrder(row, {
      sale_id: saleId,
      amount,
      currency_code: currencyCode,
      billed_at: billedAt,
    });

    return { action: "not_supported" };
  }

  // -------------------------------------------------------------------------
  // Renewal orders
  // -------------------------------------------------------------------------

  /**
   * Creates the renewal Medusa order: first-order items at locked prices,
   * same customer, digital (no shipping), payment collection + payment
   * carrying the PayPal sale id as the refund anchor. Idempotent per sale id.
   */
  async createRenewalOrder(
    row: SubscriptionRow,
    sale: { sale_id: string; amount: number; currency_code: string; billed_at?: string }
  ): Promise<{ order_id: string } | null> {
    const { subscriptionModule, logger } = this.deps;
    const orderModule = this.require("orderModule", "renewal order creation");
    const paymentModule = this.require("paymentModule", "renewal order creation");

    const sales = row.sales ?? [];

    if (sales.some((record) => record.sale_id === sale.sale_id)) {
      return null;
    }

    const firstOrder = await this.resolveFirstOrder(row);

    if (!firstOrder) {
      logger.error(
        `Subscription ${row.id}: renewal sale ${sale.sale_id} cannot create an order - no first order found. Reconciliation will retry.`
      );
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `No first order for subscription ${row.id}; cannot create renewal order`
      );
    }

    const [collection] = await paymentModule.createPaymentCollections([
      {
        currency_code: sale.currency_code,
        amount: sale.amount,
      },
    ]);

    const session = await paymentModule.createPaymentSession(collection.id, {
      provider_id: row.provider_id ?? "pp_paypal",
      amount: sale.amount,
      currency_code: sale.currency_code,
      data: {
        subscription_renewal: true,
        is_subscription: true,
        paypal_subscription_id: row.paypal_subscription_id,
        paypal_subscription_row_id: row.id,
        paypal_sale_id: sale.sale_id,
        status: "captured",
      },
    });

    const payment = await paymentModule.authorizePaymentSession(session.id, {});

    if (!payment) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Renewal payment authorization returned no payment for subscription ${row.id}`
      );
    }

    await paymentModule.capturePayment({ payment_id: payment.id, amount: sale.amount });

    const items = (firstOrder.items ?? []).map((item: any) => ({
      title: item.title,
      subtitle: item.subtitle,
      quantity: item.quantity,
      unit_price: item.unit_price,
      variant_id: item.variant_id,
      product_id: item.product_id,
      thumbnail: item.thumbnail,
    }));

    const [order] = await orderModule.createOrders([
      {
        region_id: firstOrder.region_id,
        currency_code: firstOrder.currency_code ?? sale.currency_code,
        customer_id: firstOrder.customer_id ?? row.customer_id,
        email: firstOrder.email,
        items,
        metadata: {
          paypal_subscription_id: row.paypal_subscription_id,
          paypal_subscription_row_id: row.id,
          paypal_sale_id: sale.sale_id,
          paypal_renewal: true,
        },
        payment_collection_id: collection.id,
      },
    ]);

    await subscriptionModule.updatePaypalSubscriptions({
      id: row.id,
      last_billing_at: sale.billed_at ?? new Date().toISOString(),
      failure_count: 0,
      sales: [
        ...sales,
        {
          sale_id: sale.sale_id,
          order_id: order.id,
          payment_collection_id: collection.id,
          payment_id: payment.id,
          amount: sale.amount,
          currency_code: sale.currency_code,
          billed_at: sale.billed_at,
        } as SubscriptionSaleRecord,
      ],
    });

    await this.notifyRailChange(
      row,
      "payment_succeeded",
      toRailStatus(row.status) ?? "active",
      { lastBillingAt: sale.billed_at }
    );

    return { order_id: order.id };
  }

  /**
   * First order derived through the documented chain:
   * subscription row -> payment session -> payment collection -> order.
   */
  async resolveFirstOrder(row: SubscriptionRow): Promise<any | null> {
    const query = this.require("query", "order resolution");
    const orderModule = this.require("orderModule", "order resolution");

    // The order table has no payment_collection_id column - orders link to
    // payment collections through the order_payment_collection link, which
    // is only reachable via the query graph.
    let collectionId = row.payment_collection_id;

    if (!collectionId) {
      const paymentModule = this.require("paymentModule", "order resolution");
      const session = await paymentModule.retrievePaymentSession(
        row.payment_session_id
      );

      collectionId = session?.payment_collection_id ?? null;
    }

    if (!collectionId) {
      return null;
    }

    const links = await query.graph({
      entity: "order_payment_collection",
      fields: ["order_id"],
      filters: { payment_collection_id: collectionId },
    });

    const orderId = links?.data?.[0]?.order_id;

    if (!orderId) {
      return null;
    }

    const orders = await orderModule.listOrders(
      { id: orderId },
      { relations: ["items"], take: 1 }
    );

    return orders?.[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Refunds (bidirectional)
  // -------------------------------------------------------------------------

  /**
   * Medusa -> PayPal: refunds the sale recorded on the payment data (renewal)
   * or the subscription row's first sale (first order). A sale that is
   * already fully refunded at PayPal (webhook-originated sync) skips the
   * PayPal call so the same path stays idempotent.
   */
  async refundSubscriptionPayment(
    data: Record<string, unknown>,
    amount: number | undefined
  ): Promise<{ refundId?: string; saleId: string }> {
    const { client, subscriptionModule } = this.deps;

    let saleId = data.paypal_sale_id as string | undefined;

    if (!saleId) {
      const row = await this.findRowBySessionData(data);

      saleId = row?.first_sale_id ?? undefined;

      if (!saleId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Subscription payment has no captured PayPal sale to refund (free-trial subscriptions cannot be refunded before the first charge)."
        );
      }
    }

    // The stored id is a v2 capture on the current subscriptions platform
    // (charges are captures under the hood even though webhooks keep the
    // PAYMENT.SALE.* names); fall back to the v1 sale rail for legacy ids.
    let rail: "capture" | "sale";
    let status: string;
    let grossMajor = 0;
    let railCurrency: string | undefined;

    try {
      const capture = await client.getCapture(saleId);
      rail = "capture";
      status = capture.status;
      grossMajor = Number(capture.amount?.value ?? 0);
      railCurrency = capture.amount?.currency_code;
    } catch (error) {
      if ((error as any)?.paypalStatus !== 404) {
        throw error;
      }

      const sale = await client.getSale(saleId);
      rail = "sale";
      status = String((sale as any).state ?? sale.status);
      grossMajor = Number(sale.amount?.value ?? 0);
      railCurrency = sale.amount?.currency_code;
    }

    const normalizedStatus = status.toLowerCase();

    if (normalizedStatus === "refunded" || normalizedStatus === "reversed") {
      return { saleId };
    }

    // No explicit amount = refund the full remaining balance at PayPal
    // (correct after partial refunds, where gross > remaining).
    const refundAmount = amount ?? grossMajor;
    const currency = (data.currency_code as string) ?? railCurrency;
    const paypalAmount =
      amount == null
        ? undefined
        : {
            value: formatPaypalAmount(
              refundAmount,
              await getPaypalFractionDigits(
                this.deps.query,
                currency ?? "USD",
                this.deps.logger
              )
            ),
            currency_code: currency ?? "USD",
          };
    const note =
      typeof data.refund_reason === "string"
        ? (data.refund_reason as string)
        : undefined;

    const refund =
      rail === "capture"
        ? await client.refundCapture(saleId, paypalAmount, note)
        : await client.refundSale(saleId, paypalAmount, note);

    if (data.is_subscription) {
      const row = await this.findRowBySessionData(data);

      if (row) {
        await subscriptionModule.updatePaypalSubscriptions({
          id: row.id,
          refunds: [
            ...(row.refunds ?? []),
            {
              refund_id: refund.id,
              sale_id: saleId,
              order_id: null,
              amount: refundAmount,
              currency_code: currency,
              refunded_at: new Date().toISOString(),
            } as SubscriptionRefundRecord,
          ],
        });
      }
    }

    return { refundId: refund.id, saleId };
  }

  /**
   * PayPal -> Medusa: records panel refunds of subscription charges made on
   * the PayPal side. The current platform fires PAYMENT.CAPTURE.REFUNDED /
   * REVERSED for these (not PAYMENT.SALE.REFUNDED), and the subscription's
   * custom_id (our payment session id) is propagated onto the refund's
   * `custom` field, which is the resolution anchor here. Works for both full
   * and partial refunds - the refunded amount is what PayPal reports.
   */
  async syncCaptureRefundFromPaypal(resource: any): Promise<void> {
    const { subscriptionModule, logger } = this.deps;

    // The webhook resource names the field custom_id (the REST refund object
    // calls it custom) - accept both.
    const sessionId = resource?.custom ?? resource?.custom_id;
    const refundId = resource?.id;

    if (!sessionId || !refundId) {
      logger.warn(
        "Capture refund webhook without a session reference (custom); ignoring"
      );
      return;
    }

    const rows = (await subscriptionModule.listPaypalSubscriptions({
      payment_session_id: sessionId,
    })) as SubscriptionRow[];

    const row = rows?.[0];

    if (!row) {
      logger.warn(
        `Capture refund webhook for unknown session ${sessionId}; ignoring`
      );
      return;
    }

    if ((row.refunds ?? []).some((r) => r.refund_id === refundId)) {
      return;
    }

    const amount = Number(resource.amount?.value ?? 0);
    const currencyCode =
      resource.amount?.currency_code ?? row.currency_code;

    const firstOrder = await this.resolveFirstOrderSafe(row);
    const orderId = firstOrder?.id ?? null;

    if (paymentModuleAvailable(this.deps) && orderId && amount > 0) {
      try {
        // Payments are linked to sessions directly (payment.payment_session_id);
        // the order entity carries no payment collection id in 2.x.
        const payments = await this.deps.paymentModule.listPayments({
          payment_session_id: sessionId,
        });
        const payment = payments?.[0];

        if (payment?.id) {
          await this.deps.paymentModule.refundPayment({
            payment_id: payment.id,
            amount,
          });
        }
      } catch (error) {
        logger.warn(
          `Capture refund ${refundId}: could not record the Medusa refund on order ${orderId}: ${String(error)}`
        );
      }
    }

    await subscriptionModule.updatePaypalSubscriptions({
      id: row.id,
      refunds: [
        ...(row.refunds ?? []),
        {
          refund_id: refundId,
          sale_id: row.first_sale_id ?? null,
          order_id: orderId,
          amount,
          currency_code: currencyCode,
          refunded_at: new Date().toISOString(),
        } as SubscriptionRefundRecord,
      ],
    });
  }

  /**
   * PayPal -> Medusa: records panel refunds against the matching order.
   * Full refunds (sale fully refunded at PayPal) create a Medusa refund on
   * the order's payment through the standard refund flow - the provider
   * detects the already-refunded sale and skips the PayPal call. Partial
   * refunds are recorded on the subscription row and surfaced via logs until
   * a record-only refund API exists (documented limitation).
   */
  async syncRefundFromPaypal(resource: any): Promise<void> {
    const { subscriptionModule, logger } = this.deps;
    const orderModule = this.require("orderModule", "refund sync");
    const paymentModule = this.require("paymentModule", "refund sync");

    const refundId = resource?.id;
    const saleId = resource?.sale_id;
    const row = await this.findRowByPaypalId(resource?.billing_agreement_id);

    if (!row || !saleId) {
      logger.warn(`Refund webhook without subscription/sale reference; ignoring`);
      return;
    }

    if ((row.refunds ?? []).some((r) => r.refund_id === refundId)) {
      return;
    }

    const amount = Number(resource?.amount?.total ?? resource?.amount?.value ?? 0);
    const currencyCode =
      resource?.amount?.currency ?? resource?.amount?.currency_code ?? row.currency_code;

    const saleRecord = (row.sales ?? []).find((s) => s.sale_id === saleId);

    let orderId = saleRecord?.order_id ?? null;
    let collectionId = saleRecord?.payment_collection_id ?? null;

    if (!orderId) {
      const firstOrder = await this.resolveFirstOrder(row);

      orderId = firstOrder?.id ?? null;
      collectionId = collectionId ?? firstOrder?.payment_collection_id ?? null;
    }

    const record: SubscriptionRefundRecord = {
      refund_id: refundId,
      sale_id: saleId,
      order_id: orderId,
      amount,
      currency_code: currencyCode,
      refunded_at: resource?.create_time ?? new Date().toISOString(),
    };

    let sale: any;

    try {
      sale = await this.deps.client.getSale(saleId);
    } catch (error) {
      logger.warn(`Could not fetch sale ${saleId} for refund sync: ${String(error)}`);
    }

    const fullyRefunded = sale?.status === "REFUNDED" || sale?.status === "REVERSED";

    if (orderId && collectionId && fullyRefunded) {
      try {
        const collection = await paymentModule.listPaymentCollections(
          { id: collectionId },
          { relations: ["payments", "payments.refunds"] }
        );
        const payment = collection?.[0]?.payments?.[0];

        if (payment) {
          const refundedSoFar = (payment.refunds ?? []).reduce(
            (sum: number, refund: any) => sum + Number(refund.amount ?? 0),
            0
          );
          const remaining = Number(payment.amount) - refundedSoFar;

          if (remaining > 0) {
            await paymentModule.refundPayment({
              payment_id: payment.id,
              amount: Math.min(amount, remaining) || remaining,
            });
          }
        }
      } catch (error) {
        logger.error(
          `Could not record Medusa refund for subscription refund ${refundId}: ${String(error)}`
        );
      }
    } else {
      logger.warn(
        `Partial PayPal refund ${refundId} recorded on subscription ${row.id} without a Medusa refund record (full refunds only).`
      );
    }

    await subscriptionModule.updatePaypalSubscriptions({
      id: row.id,
      refunds: [...(row.refunds ?? []), record],
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle management
  // -------------------------------------------------------------------------

  /**
   * Admin lifecycle action. PayPal is updated first, then the local row -
   * the incoming webhook for the same change finds the row already
   * transitioned and stays silent.
   */
  async requestLifecycleAction(
    row: SubscriptionRow,
    action: "cancel" | "suspend" | "resume"
  ): Promise<SubscriptionRow> {
    const { client } = this.deps;

    const targetStatus: PaypalSubscriptionStatus =
      action === "cancel" ? "CANCELLED" : action === "suspend" ? "SUSPENDED" : "ACTIVE";

    if (row.status === targetStatus) {
      return row;
    }

    try {
      await client.subscriptionAction(
        row.paypal_subscription_id,
        action === "resume" ? "activate" : action
      );
    } catch (error: any) {
      // PayPal rejects no-op transitions (422); treat them as converged.
      if (error?.paypalStatus !== 422) {
        throw error;
      }
    }

    return (await this.transitionRow(row, targetStatus, "status")) as SubscriptionRow;
  }

  async customerCancel(
    row: SubscriptionRow,
    customerId: string
  ): Promise<SubscriptionRow> {
    if (row.customer_id !== customerId) {
      // Not-found instead of forbidden: do not leak other customers' rows.
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Subscription ${row.id} not found`
      );
    }

    return this.requestLifecycleAction(row, "cancel");
  }

  /**
   * Switches a subscription to another plan in place (PayPal `revise`): the
   * subscription id, its approval and its billing history survive, the new
   * plan applies from the next billing cycle, and the remainder of the current
   * cycle is not prorated.
   *
   * PayPal treats a plan change as a **consent request**: the call answers 200
   * with a `rel=approve` link and the subscription keeps billing on the old
   * plan until the buyer opens that link (PayPal docs: "This type of update
   * requires the buyer's consent"; confirmed against the sandbox on
   * 2026-10-10). The local row is therefore left untouched while the switch is
   * pending - writing the new plan here would show the customer a plan PayPal
   * is not billing yet. The row moves when PayPal confirms the switch: the
   * BILLING.SUBSCRIPTION.UPDATED webhook, the reconciliation pass, or a revise
   * that came back without an approval link at all.
   *
   * The rail is notified with `transition: "status"`: a revise keeps the
   * subscription where it is, so the host only has to refresh its mirror row -
   * the new plan id, price and interval ride along in the record itself. No
   * event name is involved here (see `notifyRailChange`).
   */
  async customerRevise(
    row: SubscriptionRow,
    customerId: string,
    input: { variantId: string }
  ): Promise<CustomerReviseResult> {
    const { client, subscriptionModule } = this.deps;

    if (row.customer_id !== customerId) {
      // Not-found instead of forbidden: do not leak other customers' rows.
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Subscription ${row.id} not found`
      );
    }

    // The price of the target plan is the variant's live price for the
    // subscription's own currency - a subscription never changes currency.
    const target = await this.resolveSubscriptionVariant(
      input.variantId,
      row.currency_code
    );

    if (!target) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Variant ${input.variantId} is not a subscription variant`
      );
    }

    // Already on the requested plan: converge instead of calling PayPal, so a
    // retry of a switch that already landed is a no-op rather than an error.
    if (target.variant.id === row.variant_id) {
      return { subscription: row, approvalUrl: null, pending: false };
    }

    // PayPal answers 422 SUBSCRIPTION_STATUS_INVALID ("subscription status
    // should be active") for a revise on anything but an active agreement, so
    // a suspended subscription is told to resume first instead of failing at
    // PayPal.
    if (row.status !== "ACTIVE") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Subscription ${row.id} cannot switch plans while it is ${row.status}. Resume the subscription first, then switch its plan.`
      );
    }

    await this.assertPlanSwitchIsIntraProduct(row, target.variant);

    const { planRow } = await this.ensurePlan({
      variant: target.variant,
      config: target.declaration,
      currencyCode: row.currency_code,
      amount: target.amount,
    });

    // Deterministic idempotency key: PayPal keeps it for 72h, so a retried
    // switch reuses the original response instead of revising twice.
    const requestId = `revise-${row.id}-${planRow.paypal_plan_id}`;

    let revised: PaypalSubscriptionResponse | undefined;

    try {
      revised = await client.reviseSubscription(
        row.paypal_subscription_id,
        planRow.paypal_plan_id,
        requestId
      );
    } catch (error: any) {
      // PayPal's own compatibility rules are the last word (our product check
      // can only see the variants, not the plans PayPal already holds).
      if (error?.paypalStatus === 422 || error?.paypalStatus === 400) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `PayPal rejected the plan switch for subscription ${row.id}: ${error.message}`
        );
      }

      throw error;
    }

    const approvalUrl = extractApproveUrl(revised?.links);

    if (approvalUrl) {
      // Waiting on the buyer: the storefront sends them to PayPal and the
      // switch lands through the webhook (or the reconciliation pass).
      return { subscription: row, approvalUrl, pending: true };
    }

    const switched = await this.applyPlanSwitch(row, {
      variantId: target.variant.id,
      planId: planRow.paypal_plan_id,
      amount: target.amount,
      intervalUnit: target.declaration.interval_unit,
      intervalCount: target.declaration.interval_count,
    });

    return { subscription: switched, approvalUrl: null, pending: false };
  }

  /**
   * Writes a plan switch that PayPal has already confirmed. Shared by the
   * revise path (a switch that needed no consent), the
   * BILLING.SUBSCRIPTION.UPDATED webhook and the reconciliation pass, so all
   * three land identically: variant, plan id, locked amount and interval move
   * together, and the rail is notified once with `transition: "status"`.
   */
  private async applyPlanSwitch(
    row: SubscriptionRow,
    target: {
      variantId: string;
      planId: string;
      amount: number;
      intervalUnit: string;
      intervalCount: number;
    }
  ): Promise<SubscriptionRow> {
    const updated = firstOrSelf(
      await this.deps.subscriptionModule.updatePaypalSubscriptions({
        id: row.id,
        variant_id: target.variantId,
        paypal_plan_id: target.planId,
        locked_amount: target.amount,
        interval_unit: target.intervalUnit,
        interval_count: target.intervalCount,
      })
    );

    const next =
      (updated as SubscriptionRow) ??
      ({
        ...row,
        variant_id: target.variantId,
        paypal_plan_id: target.planId,
        locked_amount: target.amount,
        interval_unit: target.intervalUnit,
        interval_count: target.intervalCount,
      } as SubscriptionRow);

    await this.notifyRailChange(next, "status", toRailStatus(next.status));

    return next;
  }

  /**
   * Resolves a PayPal plan id back to a local plan row and applies the switch.
   * Returns null (after a warning) when PayPal reports a plan this plugin does
   * not know - a plan created outside the plugin, or pricing the host has since
   * retired. The row then keeps its old plan id, which is visible in the admin
   * and fixable, instead of pointing at a variant the host cannot price.
   */
  private async applyPaypalPlanToRow(
    row: SubscriptionRow,
    paypalPlanId: string
  ): Promise<SubscriptionRow | null> {
    const plans = await this.deps.subscriptionModule.listPaypalPlans({
      paypal_plan_id: paypalPlanId,
    });
    const planRow = plans?.[0];

    if (!planRow) {
      this.deps.logger.warn(
        `Subscription ${row.id} is on PayPal plan ${paypalPlanId}, which this plugin does not know; keeping the local plan ${row.paypal_plan_id}.`
      );
      return null;
    }

    const target = await this.resolveSubscriptionVariant(
      planRow.variant_id,
      row.currency_code
    );

    if (!target) {
      this.deps.logger.warn(
        `PayPal plan ${paypalPlanId} points at variant ${planRow.variant_id}, which is no longer a subscription variant; keeping the local plan for ${row.id}.`
      );
      return null;
    }

    return this.applyPlanSwitch(row, {
      variantId: target.variant.id,
      planId: paypalPlanId,
      amount: target.amount,
      intervalUnit: target.declaration.interval_unit,
      intervalCount: target.declaration.interval_count,
    });
  }

  /**
   * PayPal refuses a revise whose plan belongs to another product
   * (PLAN_PRODUCT_NOT_COMPATIBLE), and a cross-product switch is not something
   * the customer can decide on their own anyway: the two products have
   * different delivery and entitlement stories. Checked here so the storefront
   * gets a message that names the way out instead of a PayPal 422.
   */
  private async assertPlanSwitchIsIntraProduct(
    row: SubscriptionRow,
    targetVariant: any
  ): Promise<void> {
    const targetProductId = targetVariant?.product_id;

    if (!targetProductId) {
      return;
    }

    const productModule = this.require("productModule", "plan switch");
    const currentVariants = await listVariantsByIds(productModule, [
      row.variant_id,
    ]);
    const currentProductId = currentVariants?.[0]?.product_id;

    if (currentProductId && currentProductId !== targetProductId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "A subscription can only switch to another plan of the same product. To move to a different product, cancel this subscription and subscribe to the new one."
      );
    }
  }

  /**
   * Reports one row change to the host's injected hook.
   *
   * This is the engine's only publication path, and it holds no event name: the
   * name, the payload shape and the publication all live in
   * `medusa-payment-methods`, whose `emitNativeSubscriptionChanged` the host
   * wires into this plugin's options. A missing hook is a boot warning (logged
   * once by the module service), and a throwing hook is warned and swallowed —
   * an event failure must never fail a webhook that already charged someone.
   */
  private async notifyRailChange(
    row: SubscriptionRow,
    transition: NativeSubscriptionTransition,
    status: RailStatus | null,
    overrides: { lastBillingAt?: unknown; nextBillingAt?: unknown } = {}
  ): Promise<void> {
    const hook: NativeSubscriptionChangedHook | undefined =
      this.deps.options?.onNativeSubscriptionChanged;

    if (typeof hook !== "function") {
      return;
    }

    const payload = toNativeSubscriptionChangedPayload({
      row,
      status,
      transition,
      lastBillingAt: overrides.lastBillingAt,
      nextBillingAt: overrides.nextBillingAt,
    });

    try {
      await hook(this.deps.eventBus, payload);
    } catch (error) {
      this.deps.logger.warn(
        `Rail event for subscription ${row.id} failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async transitionRow(
    row: SubscriptionRow,
    status: PaypalSubscriptionStatus,
    transition: NativeSubscriptionTransition | null = null
  ): Promise<SubscriptionRow | void> {
    const previous = row.status;

    if (previous === status) {
      return row;
    }

    const updated = firstOrSelf(
      await this.deps.subscriptionModule.updatePaypalSubscriptions({
        id: row.id,
        status,
      })
    );

    const next = (updated as SubscriptionRow) ?? { ...row, status };

    if (transition) {
      await this.notifyRailChange(next, transition, toRailStatus(status));
    }

    return next;
  }

  // -------------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------------

  /**
   * Daily safety net: aligns local status with PayPal, replays missed
   * first-period captures through the standard payment workflow (which
   * completes never-returned carts), and backfills missed renewal orders.
   * Every branch is idempotent - repeated runs are no-ops.
   */
  async reconcile(): Promise<{ aligned: number; salesBackfilled: number; firstPurchasesBackfilled: number; customersBackfilled: number }> {
    const { subscriptionModule, logger, client } = this.deps;

    // APPROVAL_PENDING rows are included so stuck approvals (buyer approved,
    // activation webhook lost) still converge to PayPal's state.
    const rows = (await subscriptionModule.listPaypalSubscriptions({
      status: ["APPROVAL_PENDING", "ACTIVE", "SUSPENDED"],
    })) as SubscriptionRow[];

    let aligned = 0;
    let salesBackfilled = 0;
    let firstPurchasesBackfilled = 0;
    let customersBackfilled = 0;

    for (const row of rows as SubscriptionRow[]) {
      // 0. Ownership backfill: rows created by a redirect checkout before the
      //    engine learned to resolve its customer carry a NULL customer_id,
      //    which hides them from the owner's subscriptions page and from the
      //    one-live-subscription guard. The cart behind the session is the
      //    authority; a guest checkout resolves to nothing and stays NULL.
      if (!row.customer_id) {
        const resolved = await this.resolveCustomerIdForSession({
          sessionId: row.payment_session_id,
        });

        if (resolved) {
          await subscriptionModule.updatePaypalSubscriptions({
            id: row.id,
            customer_id: resolved,
          });

          row.customer_id = resolved;
          customersBackfilled += 1;
        }
      }
      let subscription: any;

      try {
        subscription = await client.getSubscription(row.paypal_subscription_id);
      } catch (error) {
        logger.warn(
          `Reconciliation: could not fetch PayPal subscription ${row.paypal_subscription_id}: ${String(error)}`
        );
        continue;
      }

      // 1. Status alignment.
      const paypalStatus = subscription.status;

      if (
        ["ACTIVE", "SUSPENDED", "CANCELLED", "EXPIRED"].includes(paypalStatus) &&
        paypalStatus !== row.status
      ) {
        if (paypalStatus === "ACTIVE" && row.status === "SUSPENDED") {
          await this.transitionRow(row, "ACTIVE", "status");
        } else if (paypalStatus === "ACTIVE") {
          await this.transitionRow(row, "ACTIVE", "status");
        } else {
          await this.transitionRow(row, paypalStatus, "status");
        }
        aligned += 1;
      }

      if (subscription.billing_info?.next_billing_time) {
        const next = new Date(subscription.billing_info.next_billing_time);

        if (String(row.next_billing_at ?? "") !== String(next.toISOString())) {
          await this.deps.subscriptionModule.updatePaypalSubscriptions({
            id: row.id,
            next_billing_at: next.toISOString(),
          });
        }
      }

      // 2. Plan drift: a switch the buyer approved on PayPal's page whose
      //    webhook never arrived (or arrived while the plugin was down).
      const paypalPlanId =
        typeof subscription.plan_id === "string" ? subscription.plan_id : null;

      if (paypalPlanId && paypalPlanId !== row.paypal_plan_id) {
        const switched = await this.applyPaypalPlanToRow(row, paypalPlanId);

        if (switched) {
          aligned += 1;
        }
      }

      // 3. Missed sales backfill.
      const endTime = new Date().toISOString();
      const fallbackStart = new Date(Date.now() - 90 * 24 * 3600 * 1000);
      const startSource =
        row.last_billing_at ?? row.next_billing_at ?? (row as any).created_at;
      const startMs = startSource ? Date.parse(String(startSource)) : NaN;
      const startTime = new Date(
        Number.isNaN(startMs) ? fallbackStart.getTime() : startMs
      ).toISOString();

      let transactions: any[] = [];

      try {
        transactions = await client.listSubscriptionTransactions(
          row.paypal_subscription_id,
          startTime,
          endTime
        );
      } catch (error) {
        logger.warn(
          `Reconciliation: could not list transactions for ${row.paypal_subscription_id}: ${String(error)}`
        );
      }

      const freshRows = await subscriptionModule.listPaypalSubscriptions({
        paypal_subscription_id: row.paypal_subscription_id,
      });
      const currentRow = (freshRows[0] ?? row) as SubscriptionRow;

      // The transactions listing reports amounts under
      // amount_with_breakdown.gross_amount (not amount) - read both shapes.
      const grossAmount = (transaction: any): number =>
        Number(
          transaction.amount_with_breakdown?.gross_amount?.value ??
            transaction.amount?.value ??
            0
        );
      const grossCurrency = (transaction: any): string | undefined =>
        transaction.amount_with_breakdown?.gross_amount?.currency_code ??
        transaction.amount?.currency_code;

      // First transaction of the loop pass - even when it was recorded in a
      // previous run, its real amount is needed to complete a first order
      // whose workflow replay failed earlier (e.g. stored with amount 0).
      let firstSaleAmount: number | undefined;

      for (const transaction of transactions) {
        if (transaction.status !== "COMPLETED") {
          continue;
        }

        const amount = grossAmount(transaction);
        const currencyCode = grossCurrency(transaction) ?? row.currency_code;
        const billedAt = transaction.time;
        const knownSale = (currentRow.sales ?? []).find(
          (s) => s.sale_id === transaction.id
        );

        if (knownSale) {
          if (transaction.id === currentRow.first_sale_id) {
            firstSaleAmount = amount;
          }

          // Heal sale records stored with a wrong amount by an earlier run.
          if (knownSale.amount !== amount) {
            await this.deps.subscriptionModule.updatePaypalSubscriptions({
              id: currentRow.id,
              sales: (currentRow.sales ?? []).map((s) =>
                s.sale_id === transaction.id
                  ? { ...s, amount, currency_code: currencyCode }
                  : s
              ),
            });
          }

          continue;
        }

        if (!currentRow.first_sale_id) {
          await this.deps.subscriptionModule.updatePaypalSubscriptions({
            id: currentRow.id,
            first_sale_id: transaction.id,
            last_billing_at: billedAt,
            sales: [
              ...(currentRow.sales ?? []),
              {
                sale_id: transaction.id,
                amount,
                currency_code: currencyCode,
                billed_at: billedAt,
              } as SubscriptionSaleRecord,
            ],
          });

          await this.replayStandardPaymentWorkflow(
            "captured",
            {
              session_id: currentRow.payment_session_id,
              amount,
            },
            row
          );

          firstSaleAmount = amount;
          salesBackfilled += 1;
          firstPurchasesBackfilled += 1;
        } else {
          await this.createRenewalOrder(currentRow, {
            sale_id: transaction.id,
            amount,
            currency_code: currencyCode,
            billed_at: billedAt,
          });
          salesBackfilled += 1;
        }
      }

      // 3. First-purchase compensation: the subscription is active but its
      // first order was never completed - either the customer never returned
      // and no charge exists (free trial), or an earlier backfill recorded
      // the sale without completing the order.
      if (row.status === "ACTIVE") {
        const firstOrder = await this.resolveFirstOrderSafe(currentRow);

        if (!firstOrder) {
          const recordedFirstSale = (currentRow.sales ?? []).find(
            (s) => s.sale_id === currentRow.first_sale_id
          );
          const firstAmount =
            firstSaleAmount ?? recordedFirstSale?.amount ?? 0;

          await this.replayStandardPaymentWorkflow(
            firstAmount > 0 ? "captured" : "authorized",
            firstAmount > 0
              ? {
                  session_id: currentRow.payment_session_id,
                  amount: firstAmount,
                }
              : { session_id: currentRow.payment_session_id },
            row
          );

          firstPurchasesBackfilled += 1;
        }
      }
    }

    return { aligned, salesBackfilled, firstPurchasesBackfilled, customersBackfilled };
  }

  private async resolveFirstOrderSafe(row: SubscriptionRow): Promise<any | null> {
    try {
      return await this.resolveFirstOrder(row);
    } catch {
      return null;
    }
  }

  /**
   * Replays Medusa's standard process-payment workflow - the exact machinery
   * behind capture webhooks - so compensation behaves identically to the
   * real-time path (capture + cart completion, all idempotent).
   */
  private async replayStandardPaymentWorkflow(
    action: "captured" | "authorized",
    data: Record<string, unknown>,
    row: SubscriptionRow
  ): Promise<void> {
    const workflowEngine = this.deps.workflowEngine;

    if (!workflowEngine) {
      this.deps.logger.warn(
        `Reconciliation cannot replay the payment workflow for subscription ${row.id} (no workflow engine available).`
      );
      return;
    }

    await workflowEngine.run("process-payment-workflow", {
      input: { action, data },
    });
  }
}

export default SubscriptionEngine;
