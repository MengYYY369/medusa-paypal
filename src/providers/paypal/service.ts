import {
  AbstractPaymentProvider,
  MedusaError,
  PaymentSessionStatus,
} from "@medusajs/framework/utils";
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  RefundPaymentInput,
  RefundPaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types";
import {
  CaptureStatus,
  Order,
  PaymentTokenResponse,
} from "@paypal/paypal-server-sdk";
import { WebhookPayload } from "./types";
import { PaypalCreateOrderInput, PaypalService } from "./paypal-core";
import {
  SubscriptionEngine,
  SubscriptionEngineModules,
  SubscriptionEngineOptions,
} from "../../subscription/engine";
import { isSubscriptionEvent } from "../../subscription/engine";
import { z } from "zod";

export interface PaypalPaymentError {
  code: string;
  message: string;
  retryable: boolean;
  avsCode?: string;
  cvvCode?: string;
}

type PaypalErrorDetail = {
  issue?: string;
  description?: string;
};

type PaypalErrorBody = {
  name?: string;
  message?: string;
  details?: PaypalErrorDetail[];
};

/**
 * Pulls the decline reason out of a PayPal API error. PayPal error responses
 * carry `details[].issue` (e.g. INSTRUMENT_DECLINED); the SDK exposes them on
 * `error.result` or as a JSON string on `error.body` depending on the path.
 */
function extractPaypalDecline(error: unknown): PaypalErrorDetail {
  if (error === null || typeof error !== "object") {
    return {};
  }

  const candidate = error as { body?: unknown; result?: unknown };
  const raw = candidate.result ?? candidate.body;

  let body: PaypalErrorBody | undefined;

  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw) as PaypalErrorBody;
    } catch {
      return {};
    }
  } else if (raw !== null && typeof raw === "object") {
    body = raw as PaypalErrorBody;
  }

  const firstDetail = body?.details?.[0];

  if (firstDetail?.issue) {
    return { issue: firstDetail.issue, description: firstDetail.description };
  }

  return { issue: body?.name, description: body?.message };
}

const optionsSchema = z.object({
  clientId: z
    .string()
    .min(1, "PayPal client ID is required")
    .describe(
      "PayPal client ID used for authentication. This field is required."
    ),
  clientSecret: z.string().min(1, "PayPal client secret is required"),
  isSandbox: z.boolean().default(false),
  webhookId: z.string().optional(),
  /**
   * Webhook ID of the second (subscription) webhook. Falls back to
   * `webhookId` when omitted.
   */
  subscriptionWebhookId: z.string().optional(),
  includeShippingData: z.boolean().default(false),
  includeCustomerData: z.boolean().default(false),
  autoBillOutstanding: z.boolean().optional(),
  paymentFailureThreshold: z.number().int().positive().optional(),
});

export type PaypalPluginOptionsType = z.infer<typeof optionsSchema>;

export type PaypalPluginOptions = {
  /**
   * PayPal client ID used for authentication.
   * This field is required.
   */
  clientId: string;

  /**
   * PayPal client secret used for authentication.
   * This field is required.
   */
  clientSecret: string;

  /**
   * Whether to use PayPal’s sandbox environment for testing.
   * Default: false
   */
  isSandbox?: boolean;

  /**
   * PayPal webhook ID to validate incoming webhooks.
   * Optional.
   */
  webhookId?: string;

  /**
   * Webhook ID of the second webhook dedicated to subscription events
   * (BILLING.SUBSCRIPTION.*, PAYMENT.SALE.*). Falls back to `webhookId`.
   * Optional.
   */
  subscriptionWebhookId?: string;

  /**
   * Whether to include shipping data in transactions and responses.
   * Default: false
   */
  includeShippingData?: boolean;

  /**
   * Whether to include customer data (e.g., name, email) in transactions and responses.
   * Default: false
   */
  includeCustomerData?: boolean;
};

type InjectedDependencies = {
  logger: Logger;
  paymentModuleService: any;
};

/**
 * The subscription feature needs extra collaborators (our paypal_subscription
 * module for the rows, the order module for renewal orders, the product
 * module for variant metadata). They reach the provider cradle through the
 * payment module's `dependencies` array in medusa-config and are optional:
 * merchants not using subscriptions never have them registered and never pay
 * for them.
 */
const SUBSCRIPTION_CRADLE_KEYS = [
  "event_bus",
  "paypalSubscription",
  "order",
  "product",
] as const;

function resolveOptionalCradleDependency(
  container: Record<string, unknown> & {
    hasRegistration?: (key: string) => boolean;
    resolve?: (key: string, opts?: { allowUnregistered?: boolean }) => unknown;
  },
  key: string
): any {
  if (!container) {
    return undefined;
  }

  // Payment providers are constructed with the awilix cradle proxy, where
  // property access IS resolution: registered keys return instances and
  // unregistered keys throw AwilixResolutionError (container methods like
  // hasRegistration are NOT reachable through it).
  try {
    const value = container[key];

    if (value !== undefined && value !== null) {
      return value;
    }
  } catch {
    // Cradle resolution failure = dependency not registered.
    return undefined;
  }

  // A true awilix container (tests, direct construction) exposes the API.
  try {
    if (typeof container.hasRegistration === "function") {
      if (!container.hasRegistration(key)) {
        return undefined;
      }

      return container.resolve?.(key);
    }

    return container.resolve?.(key, { allowUnregistered: true });
  } catch {
    return undefined;
  }
}

type ProviderAccountHolderInput = {
  context?: {
    customer?: { id?: string; email?: string } | null;
    account_holder?: {
      id?: string;
      external_id?: string | null;
      email?: string | null;
      data?: Record<string, unknown> | null;
    } | null;
    [key: string]: unknown;
  };
};

type ProviderAccountHolderOutput = {
  id?: string;
  data?: Record<string, unknown>;
};

type ProviderPaymentMethod = {
  id: string;
  data: Record<string, unknown>;
};

interface InitiatePaymentInputCustom
  extends Omit<InitiatePaymentInput, "data"> {
  data?: Pick<
    PaypalCreateOrderInput,
    "items" | "shipping_info" | "email" | "return_url" | "cancel_url"
  >;
}

interface AuthorizePaymentInputData
  extends Pick<
    PaypalCreateOrderInput,
    "items" | "shipping_info" | "email" | "return_url" | "cancel_url"
  > {}

export default class PaypalModuleService extends AbstractPaymentProvider<PaypalPluginOptionsType> {
  static identifier = "paypal";

  protected client: PaypalService;
  protected logger: Logger;
  protected paymentModuleService: any;
  protected subscriptionEngine?: SubscriptionEngine;
  protected containerRef: Record<string, unknown>;

  constructor(
    container: InjectedDependencies,
    private readonly options: PaypalPluginOptionsType
  ) {
    super(container, options);

    this.logger = container.logger;
    this.paymentModuleService = container.paymentModuleService;
    this.containerRef = container as unknown as Record<string, unknown>;

    this.client = new PaypalService(this.options);
  }

  /**
   * Builds the subscription engine once, wiring whatever subscription
   * collaborators the cradle carries. Returns undefined for installs without
   * the `dependencies` opt-in - every subscription entry point surfaces a
   * clear configuration error through the engine's `require` helper.
   */
  protected getSubscriptionEngine(): SubscriptionEngine | undefined {
    if (this.subscriptionEngine) {
      return this.subscriptionEngine;
    }

    const cradle = this.containerRef;

    if (!cradle) {
      return undefined;
    }

    const modules: SubscriptionEngineModules = {};

    for (const key of SUBSCRIPTION_CRADLE_KEYS) {
      modules[key as "order"] = resolveOptionalCradleDependency(
        cradle as any,
        key
      );
    }

    const engineOptions: SubscriptionEngineOptions = {
      autoBillOutstanding: this.options.autoBillOutstanding,
      paymentFailureThreshold: this.options.paymentFailureThreshold,
    };

    this.subscriptionEngine = new SubscriptionEngine({
      client: this.client,
      logger: this.logger,
      eventBus: modules["event_bus"],
      subscriptionModule: modules["paypalSubscription"],
      productModule: modules["product"],
      orderModule: modules["order"],
      paymentModule: this.paymentModuleService,
      options: engineOptions,
    });

    return this.subscriptionEngine;
  }

  static validateOptions(options: PaypalPluginOptionsType): void {
    const result = optionsSchema.safeParse(options);

    if (!result.success) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Invalid PayPal plugin options: ${result.error.message}`
      );
    }
  }

  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      // Subscription payments (first charge and renewals) are collected by
      // PayPal on the billing agreement, not by capturing a PayPal order.
      // Capture here is Medusa bookkeeping only.
      const subscriptionSessionData = input.data as Record<string, unknown>;

      if (
        subscriptionSessionData.is_subscription ||
        subscriptionSessionData.subscription_renewal
      ) {
        return {
          data: {
            ...input.data,
            status: PaymentSessionStatus.CAPTURED,
            captured_at: new Date().toISOString(),
          },
        };
      }

      if (!input.data.id) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "PayPal order ID is required to capture payment"
        );
      }

      if (
        input.data.status === PaymentSessionStatus.CAPTURED ||
        input.data.status === "COMPLETED"
      ) {
        return {
          data: {
            ...input.data,
            status: PaymentSessionStatus.CAPTURED,
            captured_at: new Date().toISOString(),
          },
        };
      }

      const id = input.data.id as string;

      const captured = await this.client.captureOrder(id);

      return {
        data: {
          ...input.data,
          ...this.withVaultReference(captured),
          status: PaymentSessionStatus.CAPTURED,
          captured_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error("PayPal capture payment error:", error);

      // Validation MedusaErrors keep their precise messages; provider/network
      // errors map to a decline-carrying MedusaError so the renewal dunning
      // classification can read decline_code (same contract as off-session).
      if (error instanceof MedusaError) {
        throw error;
      }
      throw this.toOffSessionFailure(error, "PayPal capture failed");
    }
  }

  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    if (!input.data) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Payment data is required"
      );
    }

    // Merchant-initiated (off-session) renewals carry no PayPal order id;
    // they charge the vaulted wallet directly, before the CIT validation.
    const sessionData = input.data as Record<string, unknown>;

    if (sessionData.off_session && sessionData.payment_method) {
      return this.authorizeOffSessionPayment(input);
    }

    // Renewal orders created by the subscription engine: PayPal already
    // collected the money via the subscription, so authorization is pure
    // bookkeeping (capturePayment short-circuits on the "captured" status
    // the engine put in the session data).
    if (sessionData.subscription_renewal) {
      return {
        status: PaymentSessionStatus.AUTHORIZED,
        data: sessionData,
      };
    }

    // First purchase of a subscription: authorize once the subscription is
    // ACTIVE (with one PayPal re-query fallback), letting the standard cart
    // completion create the first order.
    if (sessionData.is_subscription || sessionData.paypal_subscription_id) {
      const engine = this.getSubscriptionEngine();

      if (!engine) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "PayPal subscriptions are not configured. Add [\"paypalSubscription\", \"order\", \"product\"] to the payment module dependencies in medusa-config."
        );
      }

      const result = await engine.authorizeSubscriptionSession({
        sessionData,
      });

      if (result.status === "authorized") {
        return {
          status: PaymentSessionStatus.AUTHORIZED,
          data: result.data,
        };
      }

      return {
        status: PaymentSessionStatus.PENDING,
        data: result.data,
      };
    }

    const data = input.data as unknown as AuthorizePaymentInputData | undefined;

    let paypalData = input.data as Order | undefined;

    const amount = input.data.amount as number;
    const currencyCode = input.data.currency_code as string;
    const orderId = paypalData?.id as string;

    if (!orderId || !amount || !currencyCode) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayPal order ID, Amount or Currency is missing, can not capture order."
      );
    }

      const isAuthorized =
        paypalData?.purchaseUnits?.[0].payments?.captures?.[0]?.status ===
        CaptureStatus.Completed;

      if (!isAuthorized) {
      try {
        paypalData = await this.client.captureOrder(orderId);
      } catch (err) {
        const body = JSON.parse(err?.body || "{}");

        const captureData = body?.purchase_units?.[0]?.payments?.captures?.[0];

        const newOrder = await this.client.createOrder({
          amount: Number(amount),
          currency: currencyCode,
          sessionId: input.context?.idempotency_key,
          items: data?.items,
          shipping_info: data?.shipping_info,
          email: data?.email,
          return_url: typeof data?.return_url === "string" ? data.return_url : undefined,
          cancel_url: typeof data?.cancel_url === "string" ? data.cancel_url : undefined,
        });

        if (!captureData) {
          const error: PaypalPaymentError = {
            code: "404",
            message:
              "Payment declined. Please try again or use a different card.",
            retryable: true,
          };

          return {
            status: PaymentSessionStatus.PENDING,
            data: {
              ...input.data,
              ...newOrder,
              error,
            },
          };
        }

        const paymentStatus = captureData?.status || CaptureStatus.Declined;
        const processorResponse = captureData?.processorResponse;

        const { error = undefined } = this.checkPaymentStatus(
          paymentStatus,
          processorResponse
        );

        return {
          status: PaymentSessionStatus.PENDING,
          data: {
            ...input.data,
            ...newOrder,
            error,
          },
        };
      }

      const captureData = paypalData.purchaseUnits?.[0].payments?.captures?.[0];

      const paymentStatus = captureData?.status || CaptureStatus.Declined;
      const processorResponse = captureData?.processorResponse;

      const { status, error = undefined } = this.checkPaymentStatus(
        paymentStatus,
        processorResponse
      );

      if (status === CaptureStatus.Declined) {
        // captureData.amount.value is PayPal's major-unit string ("10.50");
        // createOrder's contract is Medusa minor units, so scale back up.
        const newOrder = await this.client.createOrder({
          amount: Math.round(Number(captureData?.amount?.value) * 100),
          currency: captureData?.amount?.currencyCode!,
          sessionId: input.context?.idempotency_key,
          items: data?.items,
          shipping_info: data?.shipping_info,
          email: data?.email,
          return_url: typeof data?.return_url === "string" ? data.return_url : undefined,
          cancel_url: typeof data?.cancel_url === "string" ? data.cancel_url : undefined,
        });

        return {
          status: PaymentSessionStatus.PENDING,
          data: {
            ...input.data,
            ...newOrder,
            error,
          },
        };
      }
    }

    return {
      data: this.withVaultReference(paypalData as Order),
      status: PaymentSessionStatus.AUTHORIZED,
    };
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      const orderId = input.data["id"] as string;

      if (!orderId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Cancel payment failed! PayPal order ID and capture ID is required to cancel payment"
        );
      }

      return {
        data: {
          order_id: orderId,
          status: PaymentSessionStatus.CANCELED,
          cancelled_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error("PayPal cancel payment error:", error);

      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Failed to cancel PayPal payment"
      );
    }
  }

  async initiatePayment(
    input: InitiatePaymentInputCustom
  ): Promise<InitiatePaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      const { amount, currency_code, context, data } = input;

      if (!amount || !currency_code) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Amount and currency code are required"
        );
      }

      const sessionData = (data ?? {}) as Record<string, unknown>;

      if (sessionData.off_session && sessionData.payment_method) {
        // Merchant-initiated renewal: no PayPal order is created up front.
        // The order against the vaulted wallet is created and captured in
        // authorizePayment, which Medusa calls next.
        return {
          id: String(sessionData.payment_method),
          data: { ...sessionData, amount, currency_code, ...(context ?? {}) },
        };
      }

      // Subscription detection: with the product module available, a cart
      // whose items carry `paypal_subscription` metadata takes the
      // subscription branch (PayPal Billing subscription instead of an
      // order). Without the module the metadata cannot be read and checkout
      // proceeds exactly as before - subscriptions require the opt-in.
      const engine = this.getSubscriptionEngine();

      if (engine) {
        const detection = await engine.detectSubscriptionSession(data?.items);

        if (detection.subscription && detection.variant) {
          const sessionId = context?.idempotency_key;

          if (!sessionId) {
            throw new MedusaError(
              MedusaError.Types.INVALID_DATA,
              "PayPal subscription checkout requires a payment session id"
            );
          }

          const initiated = await engine.initiateSubscriptionSession({
            sessionId,
            variantId: detection.variant.id,
            currencyCode: currency_code,
            amount: Number(amount),
            email: typeof data?.email === "string" ? data.email : undefined,
            customerId:
              typeof sessionData.customer_id === "string"
                ? sessionData.customer_id
                : undefined,
            returnUrl:
              typeof data?.return_url === "string" ? data.return_url : undefined,
            cancelUrl:
              typeof data?.cancel_url === "string" ? data.cancel_url : undefined,
          });

          return {
            id: initiated.paypalSubscriptionId,
            data: {
              ...data,
              ...context,
              amount,
              currency_code,
              is_subscription: true,
              paypal_subscription_id: initiated.paypalSubscriptionId,
              paypal_subscription_row_id: initiated.row.id,
              // PayPal subscription approval link - same session-data key as
              // the redirect flow, so storefronts need no changes.
              ...(initiated.approveLink && { redirect_url: initiated.approveLink }),
            },
          };
        }
      }

      const order = await this.client.createOrder({
        amount: Number(amount),
        currency: currency_code,
        sessionId: context?.idempotency_key,
        items: data?.items,
        shipping_info: data?.shipping_info,
        email: data?.email,
        vaultCustomerId:
          typeof sessionData.customer_id === "string"
            ? sessionData.customer_id
            : undefined,
        return_url: typeof data?.return_url === "string" ? data.return_url : undefined,
        cancel_url: typeof data?.cancel_url === "string" ? data.cancel_url : undefined,
      });

      const approveLink = order.links?.find((link) => link.rel === "approve")
        ?.href;

      return {
        data: {
          ...data,
          ...order,
          ...context,
          amount,
          currency_code,
          // PayPal's payer approval link. Consumed by redirect-only flows
          // (manual renewals) and useful as a fallback for storefronts.
          ...(approveLink && { redirect_url: approveLink }),
        },

        id: order.id!,
      };
    } catch (error) {
      this.logger.error("PayPal initiate payment error:", error);
      throw error;
    }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      // Subscription payments carry a PayPal sale id (renewals) or reference
      // the subscription row (first order) instead of Orders v2 captures -
      // refund through the sale-refund API.
      const subscriptionSessionData = input.data as Record<string, unknown>;

      if (
        subscriptionSessionData.is_subscription ||
        subscriptionSessionData.paypal_sale_id
      ) {
        const engine = this.getSubscriptionEngine();

        if (!engine) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "PayPal subscriptions are not configured. Add [\"paypalSubscription\", \"order\", \"product\"] to the payment module dependencies in medusa-config."
          );
        }

        const result = await engine.refundSubscriptionPayment(
          subscriptionSessionData,
          input.amount == null ? undefined : Number(input.amount)
        );

        return {
          data: {
            ...input.data,
            ...(result.refundId && { paypal_refund_id: result.refundId }),
          },
        };
      }

      const orderId = input.data["id"] as string;
      const purchaseUnits =
        (input?.data?.["purchaseUnits"] as Order["purchaseUnits"]) || [];

      const captureIds = purchaseUnits
        ?.flatMap((item) =>
          item?.payments?.captures?.map((capture) => capture.id)
        )
        .filter((id) => id !== undefined);

      if (!orderId || !captureIds) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Refund payment failed! PayPal order ID and capture ID is required to cancel payment"
        );
      }

      await this.client.refundPayment(captureIds);

      return {
        data: {
          order_id: orderId,
          status: PaymentSessionStatus.CANCELED,
          cancelled_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error("PayPal refund payment error:", error);

      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Failed to refund PayPal payment"
      );
    }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      const orderId = input.data["id"] as string;

      if (!orderId) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Delete payment failed! PayPal order ID and capture ID is required to cancel payment"
        );
      }

      return {
        data: {
          order_id: orderId,
          status: PaymentSessionStatus.CANCELED,
          cancelled_at: new Date().toISOString(),
        },
      };
    } catch (error) {
      this.logger.error("PayPal cancel payment error:", error);
      throw error;
    }
  }

  /**
   * Registers a Medusa account holder for a customer. PayPal has no
   * server-side holder entity: the Medusa customer id doubles as the
   * merchant-side customer id used to associate wallets at save time
   * (merchant_customer_id) and to list them afterwards.
   */
  async createAccountHolder(
    input: ProviderAccountHolderInput
  ): Promise<ProviderAccountHolderOutput> {
    const customerId = input.context?.customer?.id;

    if (!customerId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayPal account holder creation requires a customer"
      );
    }

    return {
      id: customerId,
      data: {
        ...(input.context?.customer?.email && {
          email: input.context.customer.email,
        }),
      },
    };
  }

  /**
   * Lists the vaulted PayPal wallets saved for an account holder. The
   * holder's external id is the merchant-side customer id the wallets were
   * associated with when they were saved.
   */
  async listPaymentMethods(input: {
    context?: {
      account_holder?: {
        external_id?: string | null;
      } | null;
    };
  }): Promise<ProviderPaymentMethod[]> {
    const externalId = input.context?.account_holder?.external_id;

    if (!externalId) {
      return [];
    }

    const tokens = await this.client.listVaultedPaymentMethods(
      String(externalId)
    );

    return tokens
      .filter(
        (token): token is PaymentTokenResponse & { id: string } =>
          !!token.id && !!token.paymentSource?.paypal
      )
      .map((token) => ({
        id: token.id,
        data: {
          type: "paypal",
          email: token.paymentSource?.paypal?.emailAddress ?? null,
        },
      }));
  }

  /**
   * Verifies a webhook signature against the primary webhook id, falling
   * back to the subscription webhook id when one is configured - events
   * delivered on the second webhook are signed with its id, so verification
   * must try both to keep mixed topologies working.
   */
  private async verifyWebhookSignature(
    headers: Record<string, string>,
    body: object
  ): Promise<void> {
    try {
      await this.client.verifyWebhook({ headers, body });
      return;
    } catch (error) {
      if (!this.options.subscriptionWebhookId) {
        throw error;
      }

      await this.client.verifyWebhook({
        headers,
        body,
        webhookId: this.options.subscriptionWebhookId,
      });
    }
  }

  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      // Subscription sessions have no PayPal order behind them; status is
      // driven by the billing agreement.
      const subscriptionSessionData = input.data as Record<string, unknown>;

      if (
        subscriptionSessionData.is_subscription ||
        subscriptionSessionData.subscription_renewal
      ) {
        return {
          status:
            subscriptionSessionData.first_sale_id ||
            subscriptionSessionData.paypal_sale_id
              ? PaymentSessionStatus.CAPTURED
              : PaymentSessionStatus.AUTHORIZED,
        };
      }

      const order_id = input.data["id"] as string;

      if (!order_id) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "PayPal order ID is required to cancel payment"
        );
      }

      const order = await this.client.retrieveOrder(order_id);

      if (!order || !order.status) {
        throw new MedusaError(
          MedusaError.Types.NOT_FOUND,
          `PayPal order with ID ${order_id} not found`
        );
      }

      return {
        status:
          order.status === "COMPLETED"
            ? PaymentSessionStatus.CAPTURED
            : PaymentSessionStatus.AUTHORIZED,
      };
    } catch (error) {
      this.logger.error("PayPal get payment status error:", error);
      throw error;
    }
  }

  async retrievePayment(input: Record<string, unknown>) {
    try {
      const id = input["id"] as string;

      const sessionData = input as Record<string, unknown>;

      // Subscription sessions reference a billing agreement, not an order.
      if (sessionData.is_subscription || sessionData.paypal_subscription_id) {
        const engine = this.getSubscriptionEngine();

        if (!engine) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "PayPal subscriptions are not configured"
          );
        }

        const subscriptionId =
          (sessionData.paypal_subscription_id as string) ?? id;
        const subscription = await this.client.getSubscription(subscriptionId);

        return { data: { response: subscription } };
      }

      const res = await this.client.retrieveOrder(id);
      return {
        data: { response: res },
      };
    } catch (error) {
      this.logger.error("PayPal retrieve payment error:", error);
      throw error;
    }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "Not implemented");
  }

  async getWebhookActionAndData(
    payload: WebhookPayload
  ): Promise<WebhookActionResult> {
    const { data, headers } = payload;

    try {
      await this.verifyWebhookSignature(headers, data);
    } catch (e) {
      // Never act on events whose signature could not be verified. In
      // particular, returning action "failed" here would let an
      // unverifiable event tear down payment sessions.
      this.logger.warn(
        `PayPal webhook signature verification failed: ${String(e)}`
      );
      return { action: "not_supported" };
    }

    // Subscription-rail events (second webhook, or the standard webhook when
    // a merchant routes everything to one): handled by the engine, which
    // returns not_supported for everything except the first-period sale
    // that must flow through the standard captured mechanism.
    const engine = this.getSubscriptionEngine();

    if (engine && isSubscriptionEvent(data.event_type)) {
      const handled = await engine.handleWebhookEvent(
        data.event_type,
        (data as any).resource
      );

      return handled ?? { action: "not_supported" };
    }

    switch (data.event_type) {
      case "PAYMENT.CAPTURE.COMPLETED":
        return {
          action: "captured",
          data: {
            session_id: data.resource.custom_id,
            amount: Number(data.resource.amount.value),
          },
        };
      case "PAYMENT.CAPTURE.DECLINED":
        // Medusa's webhook subscriber ignores "failed" actions; emitting
        // one documents the decline for merchants hooking the event stream
        // without risking session state.
        if (!data.resource.custom_id) {
          this.logger.warn(
            "PayPal capture declined webhook without a session reference; ignoring"
          );
          return { action: "not_supported" };
        }
        return {
          action: "failed",
          data: {
            session_id: data.resource.custom_id,
            amount: Number(data.resource.amount?.value ?? 0),
          },
        };
      // VAULT.PAYMENT-TOKEN.DELETED intentionally maps to not_supported:
      // saved-method listings read live vault state, so a deleted token
      // disappears on the next list without session side effects.
      default:
        return {
          action: "not_supported",
        };
    }
  }

  /**
   * Charges a vaulted PayPal wallet off-session (merchant-initiated): the
   * buyer is not present, so the order is created against the stored v3
   * payment token and captured in the same call. Every failure throws a
   * MedusaError carrying the PayPal decline reason as `decline_code` so the
   * subscription engine's dunning classification can map it.
   */
  private async authorizeOffSessionPayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const data = input.data as Record<string, unknown>;
    const amount = Number(data.amount);
    const currencyCode = data.currency_code as string;
    const vaultId = data.payment_method as string;

    if (!amount || !currencyCode || !vaultId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "PayPal off-session payment requires amount, currency code and a vaulted payment method reference"
      );
    }

    let order: Order;
    try {
      order = await this.client.createOrder({
        amount,
        currency: currencyCode,
        sessionId: input.context?.idempotency_key,
        vaultId,
      });
    } catch (error) {
      throw this.toOffSessionFailure(
        error,
        "Failed to create PayPal off-session order"
      );
    }

    // Authorize only mints the order (with the vaulted payment source). The
    // actual capture is performed by the standard capturePayment step — the
    // reorder renewal engine calls authorize then capture, and capturing
    // here would make capturePayment hit ORDER_ALREADY_CAPTURED.
    return {
      status: PaymentSessionStatus.AUTHORIZED,
      data: {
        ...data,
        ...order,
      },
    };
  }

  /**
   * Copies the vaulted payment token id of a captured PayPal order into the
   * session data as `payment_method`, the key the reorder subscription
   * engine stores in its payment context for off-session renewals.
   */
  private withVaultReference(order: Order): Record<string, unknown> {
    const vault = order.paymentSource?.paypal?.attributes?.vault;

    if (!vault?.id) {
      return { ...order };
    }

    return {
      ...order,
      vault_id: vault.id,
      payment_method: vault.id,
      ...(vault.status && { vault_status: vault.status }),
    };
  }

  private toOffSessionFailure(error: unknown, fallback: string): MedusaError {
    const { issue, description } = extractPaypalDecline(error);

    const message = issue
      ? `${fallback}: ${issue}${description ? ` — ${description}` : ""}`
      : fallback;

    const medusaError = new MedusaError(MedusaError.Types.UNAUTHORIZED, message);

    if (issue) {
      (medusaError as MedusaError & { decline_code?: string }).decline_code =
        issue;
    }

    return medusaError;
  }

  private checkPaymentStatus(
    status: CaptureStatus,
    processorResponse?: {
      avsCode?: string;
      cvvCode?: string;
      responseCode?: string;
    }
  ): { status: CaptureStatus; error?: PaypalPaymentError } {
    const processorResponseMap: Record<string, PaypalPaymentError> = {
      "0500": {
        code: "0500 - DO_NOT_HONOR",
        message:
          "Card refused by issuer. Please try again or use a different card.",
        retryable: false,
      },
      "9500": {
        code: "9500 - SUSPECTED_FRAUD",
        message:
          "Suspected fraudulent card. Please try again and use a different card.",
        retryable: false,
      },
      "5400": {
        code: "5400 - EXPIRED_CARD",
        message: "Card has expired. Please try again and use a different card.",
        retryable: false,
      },
      "5120": {
        code: "5120 - INSUFFICIENT_FUNDS",
        message:
          "Insufficient funds. Please try again or use a different card.",
        retryable: true,
      },
      "00N7": {
        code: "00N7 - CVV_FAILURE",
        message:
          "Incorrect security code. Please try again or use a different card.",
        retryable: true,
      },
      "1330": {
        code: "1330 - INVALID_ACCOUNT",
        message: "Card not valid. Please try again or use a different card.",
        retryable: true,
      },
      "5100": {
        code: "5100 - GENERIC_DECLINE",
        message: "Card is declined. Please try again or use a different card.",
        retryable: true,
      },
    };

    switch (status) {
      case "COMPLETED":
        return { status };

      case "DECLINED":
        if (processorResponse?.responseCode) {
          const errorDetails = processorResponseMap[
            processorResponse.responseCode
          ] || {
            code: processorResponse.responseCode,
            message:
              "Payment declined. Please try again or use a different card.",
            retryable: false,
          };

          return {
            status,
            error: {
              ...errorDetails,
              avsCode: processorResponse.avsCode,
              cvvCode: processorResponse.cvvCode,
            },
          };
        }

        return {
          status,
          error: {
            code: "DECLINED",
            message:
              "Payment declined. Please try again or use a different card.",
            retryable: false,
          },
        };

      default:
        return {
          status,
          error: {
            code: "UNKNOWN_STATUS",
            message: `Unknown payment status: ${status}. Please try again or use a different card.`,
            retryable: false,
          },
        };
    }
  }
}
