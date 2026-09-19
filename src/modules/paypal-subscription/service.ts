import {
  Logger,
  FindConfig,
} from "@medusajs/framework/types";
import { MedusaError, MedusaService } from "@medusajs/framework/utils";
import PaypalPlan from "./models/paypal-plan";
import PaypalSubscription from "./models/paypal-subscription";
import { PaypalService } from "../../providers/paypal/paypal-core/paypal-core";
import {
  SubscriptionEngine,
  SubscriptionEngineModules,
  SubscriptionEngineOptions,
} from "../../subscription/engine";

type InjectedDependencies = {
  logger: Logger;
  [key: string]: unknown;
};

export type PaypalSubscriptionModuleOptions = SubscriptionEngineOptions & {
  clientId?: string;
  clientSecret?: string;
  isSandbox?: boolean;
  webhookId?: string;
  subscriptionWebhookId?: string;
};

/**
 * Data-access home for the plugin's two tables plus the orchestration surface
 * routes and the reconciliation job use. The service receives the plugin
 * options (clientId/secret) so it can construct its own PayPal client - the
 * plugin's module is auto-registered and always resolvable, unlike the
 * payment provider which lives inside the payment module's container.
 */
export default class PaypalSubscriptionModuleService extends MedusaService({
  PaypalPlan,
  PaypalSubscription,
}) {
  protected logger: Logger;
  protected engine: SubscriptionEngine;

  constructor(container: InjectedDependencies, options: PaypalSubscriptionModuleOptions = {}) {
    super(...arguments);

    this.logger = (container.logger ?? console) as Logger;

    this.engine = new SubscriptionEngine({
      client: new PaypalService({
        clientId: options.clientId ?? "",
        clientSecret: options.clientSecret ?? "",
        isSandbox: options.isSandbox ?? true,
        includeShippingData: false,
        includeCustomerData: false,
        ...(options.webhookId && { webhookId: options.webhookId }),
        ...(options.subscriptionWebhookId && {
          subscriptionWebhookId: options.subscriptionWebhookId,
        }),
      }),
      logger: this.logger,
      eventBus: container["event_bus"] as any,
      subscriptionModule: this as any,
      options: {
        autoBillOutstanding: options.autoBillOutstanding,
        paymentFailureThreshold: options.paymentFailureThreshold,
      },
    });
  }

  /** Merges caller-resolved collaborators into the engine for one call. */
  private withModules(modules: SubscriptionEngineModules = {}): SubscriptionEngine {
    return this.engine.for(modules);
  }

  // -- Plans ---------------------------------------------------------------

  async syncPlanForVariant(
    { variantId, currencyCode }: { variantId: string; currencyCode: string },
    modules: SubscriptionEngineModules = {}
  ): Promise<{ paypal_plan_id: string; config_hash: string; variant_id: string; currency_code: string }> {
    const engine = this.withModules(modules);
    const resolved = await engine.resolveSubscriptionVariant(variantId, currencyCode);

    if (!resolved) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Variant ${variantId} does not carry "${"paypal_subscription"}" metadata`
      );
    }

    const { planRow } = await engine.ensurePlan({
      variant: resolved.variant,
      config: resolved.declaration,
      currencyCode,
      amount: resolved.amount,
    });

    return {
      paypal_plan_id: planRow.paypal_plan_id,
      config_hash: planRow.config_hash,
      variant_id: variantId,
      currency_code: currencyCode,
    };
  }

  listPaypalPlanRows(filters?: any, config?: FindConfig<any>): Promise<any[]> {
    return (this as any).listPaypalPlans(filters, config);
  }

  // -- Checkout ------------------------------------------------------------

  /**
   * Cart validation for the Buttons route: throws on mixed carts, returns the
   * subscription variant when the cart is a valid single-subscription order.
   */
  async detectSubscriptionSession(
    { items }: { items: any[] },
    modules: SubscriptionEngineModules = {}
  ): Promise<{ subscription: boolean; variant?: any }> {
    return this.withModules(modules).detectSubscriptionSession(items);
  }

  async getOrCreateSubscriptionForSession(
    { sessionId, email, customerId, variantId, currencyCode, amount, returnUrl, cancelUrl }: {
      sessionId: string;
      email?: string;
      customerId?: string;
      variantId: string;
      currencyCode: string;
      amount: number;
      returnUrl?: string;
      cancelUrl?: string;
    },
    modules: SubscriptionEngineModules = {}
  ): Promise<{ id: string; subscription_id: string; status: string }> {
    const { row } = await this.withModules(modules).initiateSubscriptionSession({
      sessionId,
      variantId,
      currencyCode,
      amount,
      email,
      customerId,
      returnUrl,
      cancelUrl,
    });

    return {
      id: row.paypal_subscription_id,
      subscription_id: row.paypal_subscription_id,
      status: row.status,
    };
  }

  // -- Listing / detail ----------------------------------------------------

  async listSubscriptions(
    filters: Record<string, unknown> = {},
    config?: FindConfig<any>
  ): Promise<[any[], number]> {
    return (this as any).listAndCountPaypalSubscriptions(filters, config);
  }

  async retrieveSubscriptionDetail(id: string): Promise<any> {
    return (this as any).retrievePaypalSubscription(id);
  }

  // -- Lifecycle -----------------------------------------------------------

  async requestLifecycleAction(
    id: string,
    action: "cancel" | "suspend" | "resume"
  ): Promise<any> {
    const row = await (this as any).retrievePaypalSubscription(id);

    return this.engine.requestLifecycleAction(row, action);
  }

  async listForCustomer(customerId: string): Promise<any[]> {
    return (this as any).listPaypalSubscriptions({ customer_id: customerId });
  }

  async customerCancel(id: string, customerId: string): Promise<any> {
    const row = await (this as any).retrievePaypalSubscription(id);

    return this.engine.customerCancel(row, customerId);
  }

  // -- Reconciliation ------------------------------------------------------

  async reconcile(modules: SubscriptionEngineModules = {}): Promise<{
    aligned: number;
    salesBackfilled: number;
    firstPurchasesBackfilled: number;
  }> {
    return this.withModules(modules).reconcile();
  }
}
