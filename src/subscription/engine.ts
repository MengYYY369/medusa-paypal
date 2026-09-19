import { MedusaError } from "@medusajs/framework/utils";
import { Logger, WebhookActionResult } from "@medusajs/framework/types";
import {
  PaypalService,
  PaypalBillingCycleInput,
  toPaypalMajorAmount,
} from "../providers/paypal/paypal-core/paypal-core";
import {
  parseSubscriptionMetadata,
  planConfigHash,
  PaypalSubscriptionConfig,
  PaypalSubscriptionDeclaration,
} from "./metadata";
import {
  emitSubscriptionEvent,
  PaypalSubscriptionEvents,
} from "./events";
import {
  PaypalSubscriptionStatus,
  SubscriptionEventPayload,
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
  productModule?: any;
  orderModule?: any;
  paymentModule?: any;
  /** Workflow engine, only used by the reconciliation job to replay the standard payment workflow. */
  workflowEngine?: any;
};

export type SubscriptionEngineOptions = {
  autoBillOutstanding?: boolean;
  paymentFailureThreshold?: number;
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

/** Webhook event types that belong to the subscription rail. */
export function isSubscriptionEvent(eventType: string): boolean {
  return (
    eventType.startsWith("BILLING.SUBSCRIPTION.") ||
    eventType.startsWith("PAYMENT.SALE.")
  );
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
        `PayPal subscriptions require the "${name}" to be available. Add ["paypalSubscription", "order", "product"] to the payment module "dependencies" in medusa-config (missing: ${name}) to enable ${feature}.`
      );
    }

    return module;
  }

  // -------------------------------------------------------------------------
  // Plan management
  // -------------------------------------------------------------------------

  /**
   * Fetches a variant and resolves its subscription declaration, or null when
   * the variant is not a subscription product.
   */
  async resolveSubscriptionVariant(
    variantId: string,
    currencyCode: string
  ): Promise<{ variant: any; config: PaypalSubscriptionConfig } | null> {
    const productModule = this.require("productModule", "plan resolution");

    const variants = await productModule.listVariants(
      { id: [variantId] },
      { relations: ["prices"], take: 1 }
    );

    const variant = variants?.[0];

    if (!variant) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        `Variant ${variantId} not found`
      );
    }

    const config = parseSubscriptionMetadata(variant.metadata);

    if (!config) {
      return null;
    }

    const price = (variant.prices ?? []).find(
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
      config: { ...config, amount: price.amount, currency_code: currencyCode },
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

    const variants = await productModule.listVariants(
      { id: variantIds },
      { relations: ["prices"], take: variantIds.length }
    );

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
   * Gets the cached PayPal plan for variant x currency x config hash, or
   * creates the PayPal product + plan (plan immutable -> new version per
   * hash) and caches the row.
   */
  async ensurePlan({
    variant,
    config,
    currencyCode,
  }: {
    variant: any;
    config: PaypalSubscriptionDeclaration;
    currencyCode: string;
  }): Promise<{ planRow: any; config: PaypalSubscriptionConfig }> {
    const { client } = this.deps;
    const subscriptionModule = this.deps.subscriptionModule;

    const price = (variant.prices ?? []).find(
      (p: any) => p.currency_code === currencyCode
    );

    if (!price) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Subscription variant ${variant.id} has no price for currency ${currencyCode}`
      );
    }

    const fullConfig: PaypalSubscriptionConfig = {
      ...config,
      amount: price.amount,
      currency_code: currencyCode,
    };

    const hash = planConfigHash(fullConfig);

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

    const cycles = this.buildBillingCycles(fullConfig);

    const plan = await client.createBillingPlan({
      product_id: productId,
      name: `${variant.title ?? "Subscription"} (${currencyCode})`,
      billing_cycles: cycles,
      auto_bill_outstanding: this.deps.options?.autoBillOutstanding ?? true,
      payment_failure_threshold:
        this.deps.options?.paymentFailureThreshold ?? 3,
    });

    const [planRow] = await subscriptionModule.createPaypalPlans({
      variant_id: variant.id,
      currency_code: currencyCode,
      paypal_product_id: productId,
      paypal_plan_id: plan.id,
      config_hash: hash,
      status: "ACTIVE",
    });

    return { planRow, config: fullConfig };
  }

  private buildBillingCycles(config: PaypalSubscriptionConfig): PaypalBillingCycleInput[] {
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
            value: toPaypalMajorAmount(trial.price),
            currency_code: currency,
          },
        },
        ...(config.setup_fee != null && {
          billing_preferences: {
            setup_fee: {
              value: toPaypalMajorAmount(config.setup_fee),
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
          value: toPaypalMajorAmount(config.amount),
          currency_code: currency,
        },
      },
      ...(!trial &&
        config.setup_fee != null && {
          billing_preferences: {
            setup_fee: {
              value: toPaypalMajorAmount(config.setup_fee),
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
   * Creates the PayPal subscription for a payment session (idempotent per
   * session - the Buttons route and the initiate branch converge here) and
   * records the APPROVAL_PENDING row.
   */
  async initiateSubscriptionSession({
    sessionId,
    variantId,
    currencyCode,
    email,
    customerId,
    returnUrl,
    cancelUrl,
  }: {
    sessionId: string;
    variantId: string;
    currencyCode: string;
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
    const variants = await productModule.listVariants(
      { id: [variantId] },
      { relations: ["prices"], take: 1 }
    );
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

    const { planRow, config } = await this.ensurePlan({
      variant,
      config: declaration,
      currencyCode,
    });

    const subscription = await client.createSubscription({
      plan_id: planRow.paypal_plan_id,
      custom_id: sessionId,
      ...(email && { email }),
      ...(returnUrl && { return_url: returnUrl }),
      ...(cancelUrl && { cancel_url: cancelUrl }),
    });

    const approveLink = subscription.links?.find(
      (link) => link.rel === "approve"
    )?.href;

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

    const [row] = await subscriptionModule.createPaypalSubscriptions({
      paypal_subscription_id: subscription.id,
      paypal_plan_id: planRow.paypal_plan_id,
      variant_id: variantId,
      customer_id: customerId ?? null,
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
      await this.transitionRow(row, "ACTIVE");

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
        await this.onSubscriptionActivated(resource);
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

  private async onSubscriptionActivated(resource: any): Promise<void> {
    const row = await this.findRowByPaypalId(resource?.id);

    if (!row) {
      this.deps.logger.warn(
        `BILLING.SUBSCRIPTION.ACTIVATED for unknown subscription ${resource?.id}; ignoring`
      );
      return;
    }

    if (row.status === "SUSPENDED") {
      await this.transitionRow(row, "ACTIVE", PaypalSubscriptionEvents.RESUMED);
      return;
    }

    if (row.status !== "ACTIVE") {
      await this.transitionRow(
        row,
        "ACTIVE",
        PaypalSubscriptionEvents.ACTIVATED
      );
    }
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

    await this.transitionRow(row, status, eventForStatus(status));
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

    await this.emitEvent(PaypalSubscriptionEvents.PAYMENT_FAILED, {
      subscription_id: row.id,
      paypal_subscription_id: row.paypal_subscription_id,
      status: row.status as PaypalSubscriptionStatus,
      customer_id: row.customer_id,
      variant_id: row.variant_id,
      payment: {
        amount: resource?.amount ? Math.round(Number(resource.amount.value) * 100) : 0,
        currency_code: resource?.amount?.currency_code ?? row.currency_code,
        sale_id: resource?.id ?? "",
      },
    });
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

    const amount = Math.round(Number(resource?.amount?.value ?? 0) * 100);
    const currencyCode = resource?.amount?.currency_code ?? row.currency_code;
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

      await this.emitEvent(PaypalSubscriptionEvents.PAYMENT_SUCCEEDED, {
        subscription_id: row.id,
        paypal_subscription_id: row.paypal_subscription_id,
        status: row.status as PaypalSubscriptionStatus,
        customer_id: row.customer_id,
        variant_id: row.variant_id,
        payment: { amount, currency_code: currencyCode, sale_id: saleId },
      });

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

    await this.emitEvent(PaypalSubscriptionEvents.PAYMENT_SUCCEEDED, {
      subscription_id: row.id,
      paypal_subscription_id: row.paypal_subscription_id,
      status: row.status as PaypalSubscriptionStatus,
      customer_id: row.customer_id,
      variant_id: row.variant_id,
      payment: {
        amount: sale.amount,
        currency_code: sale.currency_code,
        sale_id: sale.sale_id,
        order_id: order.id,
      },
    });

    return { order_id: order.id };
  }

  /**
   * First order derived through the documented chain:
   * subscription row -> payment session -> payment collection -> order.
   */
  async resolveFirstOrder(row: SubscriptionRow): Promise<any | null> {
    const paymentModule = this.require("paymentModule", "order resolution");
    const orderModule = this.require("orderModule", "order resolution");

    let collectionId = row.payment_collection_id;

    if (!collectionId) {
      const session = await paymentModule.retrievePaymentSession(
        row.payment_session_id
      );

      collectionId = session?.payment_collection_id ?? null;
    }

    if (!collectionId) {
      return null;
    }

    const orders = await orderModule.listOrders(
      { payment_collection_id: collectionId },
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
    const refundAmount =
      amount ?? Math.round(grossMajor * 100);
    const currency = (data.currency_code as string) ?? railCurrency;
    const paypalAmount =
      amount == null
        ? undefined
        : {
            value: toPaypalMajorAmount(refundAmount),
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

    const amount = Math.round(Number(resource?.amount?.total ?? resource?.amount?.value ?? 0) * 100);
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

    const event =
      action === "cancel"
        ? PaypalSubscriptionEvents.CANCELLED
        : action === "suspend"
          ? PaypalSubscriptionEvents.SUSPENDED
          : PaypalSubscriptionEvents.RESUMED;

    return (await this.transitionRow(row, targetStatus, event)) as SubscriptionRow;
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

  private async emitEvent(
    name: string,
    payload: SubscriptionEventPayload
  ): Promise<void> {
    if (!this.deps.eventBus?.emit) {
      this.deps.logger.warn(
        `No event bus available - dropping subscription event ${name} (${payload.subscription_id})`
      );
      return;
    }

    await emitSubscriptionEvent(this.deps.eventBus, name, payload);
  }

  private async transitionRow(
    row: SubscriptionRow,
    status: PaypalSubscriptionStatus,
    eventName?: string
  ): Promise<SubscriptionRow | void> {
    const previous = row.status;

    if (previous === status) {
      return row;
    }

    const [updated] = await this.deps.subscriptionModule.updatePaypalSubscriptions({
      id: row.id,
      status,
    });

    if (eventName) {
      await this.emitEvent(eventName, {
        subscription_id: row.id,
        paypal_subscription_id: row.paypal_subscription_id,
        status,
        customer_id: row.customer_id,
        variant_id: row.variant_id,
      });
    }

    return (updated as SubscriptionRow) ?? { ...row, status };
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
  async reconcile(): Promise<{ aligned: number; salesBackfilled: number; firstPurchasesBackfilled: number }> {
    const { subscriptionModule, logger, client } = this.deps;

    const rows = (await subscriptionModule.listPaypalSubscriptions({
      status: ["ACTIVE", "SUSPENDED"],
    })) as SubscriptionRow[];

    let aligned = 0;
    let salesBackfilled = 0;
    let firstPurchasesBackfilled = 0;

    for (const row of rows as SubscriptionRow[]) {
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
          await this.transitionRow(row, "ACTIVE", PaypalSubscriptionEvents.RESUMED);
        } else if (paypalStatus === "ACTIVE") {
          await this.transitionRow(row, "ACTIVE", PaypalSubscriptionEvents.ACTIVATED);
        } else {
          await this.transitionRow(row, paypalStatus, eventForStatus(paypalStatus));
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

      // 2. Missed sales backfill.
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

      for (const transaction of transactions) {
        if (transaction.status !== "COMPLETED") {
          continue;
        }

        if ((currentRow.sales ?? []).some((s) => s.sale_id === transaction.id)) {
          continue;
        }

        const amount = Math.round(Number(transaction.amount?.value ?? 0) * 100);
        const currencyCode = transaction.amount?.currency_code ?? row.currency_code;
        const billedAt = transaction.time;

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

      // 3. First-purchase compensation: approved + active, but the customer
      // never returned to the store and no charge exists yet (free trial).
      if (row.status === "ACTIVE" && !currentRow.first_sale_id) {
        const firstOrder = await this.resolveFirstOrderSafe(currentRow);

        if (!firstOrder) {
          await this.replayStandardPaymentWorkflow(
            "authorized",
            { session_id: currentRow.payment_session_id },
            row
          );

          firstPurchasesBackfilled += 1;
        }
      }
    }

    return { aligned, salesBackfilled, firstPurchasesBackfilled };
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

function eventForStatus(status: string): string {
  switch (status) {
    case "CANCELLED":
      return PaypalSubscriptionEvents.CANCELLED;
    case "EXPIRED":
      return PaypalSubscriptionEvents.EXPIRED;
    case "SUSPENDED":
      return PaypalSubscriptionEvents.SUSPENDED;
    case "ACTIVE":
      return PaypalSubscriptionEvents.ACTIVATED;
    default:
      return PaypalSubscriptionEvents.ACTIVATED;
  }
}
