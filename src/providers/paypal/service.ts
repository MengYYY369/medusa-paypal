import {
  AbstractPaymentProvider,
  MedusaError,
  PaymentSessionStatus,
} from "@medusajs/framework/utils";
import {
  getPaypalFractionDigits,
  resolveQueryFromCradle,
} from "../../lib/currency-digits";
import {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentMethodInput,
  DeletePaymentMethodOutput,
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
import type { NativeSubscriptionChangedHook } from "../../rail/types";
import {
  assertNoCredentialEnvironmentMismatch,
  assertPaypalConfigured,
  detectDeclaredCredentialEnvironmentMismatch,
  mergePaypalConfigLayers,
  PaypalConfigField,
  PaypalConfigSource,
  PaypalCredentialEnvironmentMismatch,
  PaypalEnvironment,
  PaypalResolvedConfig,
} from "../../modules/paypal-subscription/lib/config-resolver";
import { z } from "zod";

export interface PaypalPaymentError {
  code: string;
  message: string;
  retryable: boolean;
  avsCode?: string;
  cvvCode?: string;
}

/**
 * The payment module hands the provider its account-holder record, which
 * carries the provider `external_id`, but the published
 * `PaymentAccountHolderDTO` types only `data`. Read the field structurally,
 * exactly as `listPaymentMethods` already does - `data` is declared optional
 * only so the published DTO stays assignable to this view. An empty value
 * counts as absent so a blank id cannot resolve a PayPal customer.
 */
function readAccountHolderExternalId(context: {
  account_holder?: {
    external_id?: string | null;
    data?: Record<string, unknown>;
  } | null;
} | undefined): string | undefined {
  const externalId = context?.account_holder?.external_id;

  return typeof externalId === "string" && externalId.trim() !== ""
    ? externalId
    : undefined;
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

/**
 * A credential counts as provided only when it is a non-blank string. An
 * empty or whitespace-only value is treated as missing, so a typo'd env var
 * (`PAYPAL_CLIENT_ID=""`) cannot boot half-configured.
 */
function providesCredential(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

const optionsSchema = z.object({
  // Credentials are optional so a zero-config install can boot and be
  // configured from the admin settings page afterwards. `validateOptions`
  // still rejects an incomplete pair (exactly one set) at boot.
  clientId: z
    .string()
    .optional()
    .describe(
      "PayPal client ID used for authentication. Optional: when omitted (together with clientSecret) the plugin starts unconfigured and the credentials can be set on the admin PayPal settings page."
    ),
  clientSecret: z.string().optional(),
  isSandbox: z.boolean().default(false),
  /**
   * The environment the option-layer credential set belongs to. Declared by
   * hosts that keep per-environment credential files: while these options are
   * the layer supplying the active credentials, a contradiction with
   * `isSandbox` refuses to boot (validateOptions) and refuses every PayPal
   * call at runtime (#18) instead of hitting the wrong environment's API.
   */
  credentialEnvironment: z.enum(["sandbox", "live"]).optional(),
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
   * Optional: omit both credentials to boot unconfigured and set them on the
   * admin PayPal settings page.
   */
  clientId?: string;

  /**
   * PayPal client secret used for authentication.
   * Optional: omit both credentials to boot unconfigured and set them on the
   * admin PayPal settings page.
   */
  clientSecret?: string;

  /**
   * Whether to use PayPal’s sandbox environment for testing.
   * Default: false
   */
  isSandbox?: boolean;

  /**
   * The environment this option layer's credential set belongs to. Declared
   * by hosts that keep per-environment credential files: while these options
   * are the layer supplying the active credentials, a contradiction with
   * `isSandbox` refuses to boot and refuses every PayPal call at runtime.
   */
  credentialEnvironment?: PaypalEnvironment;

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

  /** Current PayPal client; rebuilt by `getClient` when the config changes. */
  protected client?: PaypalService;
  protected logger: Logger;
  protected paymentModuleService: any;
  protected containerRef: Record<string, unknown>;
  /** QUERY tool, reached through the awilix cradle proxy; may be absent. */
  protected query?: unknown;
  private clientCache?: { key: string; client: PaypalService };
  private subscriptionEngineCache?: { key: string; engine: SubscriptionEngine };

  constructor(
    container: InjectedDependencies,
    private readonly options: PaypalPluginOptionsType
  ) {
    super(container, options);

    this.logger = container.logger;
    this.paymentModuleService = container.paymentModuleService;
    this.containerRef = container as unknown as Record<string, unknown>;
    this.query = resolveQueryFromCradle(container);
  }

  /**
   * Reads the configuration the provider must act on right now: through the
   * subscription module's resolver when it is registered (DB overrides ->
   * provider options -> plugin options), otherwise through a local merge of
   * the bootstrap options so installs without the module dependency keep
   * working exactly as before, with no DB read. The cache key combines the
   * settings row version with the resolved values because installs without
   * the module always report version 0.
   */
  private async resolveRuntimeConfig(): Promise<{
    config: PaypalResolvedConfig;
    sources: Record<PaypalConfigField, PaypalConfigSource>;
    /** Mismatch of the module's own plugin-options declaration, when the module is registered. */
    moduleCredentialEnvironmentMismatch?: PaypalCredentialEnvironmentMismatch | null;
    key: string;
  }> {
    const subscriptionModule = resolveOptionalCradleDependency(
      this.containerRef as any,
      "paypalSubscription"
    );

    if (
      subscriptionModule &&
      typeof subscriptionModule.getResolvedPaypalConfig === "function"
    ) {
      const {
        config,
        version,
        sources,
        credentialEnvironmentMismatch,
      } = await subscriptionModule.getResolvedPaypalConfig({
        providerOptions: this.options,
      });

      return {
        config,
        sources,
        moduleCredentialEnvironmentMismatch: credentialEnvironmentMismatch,
        key: `${version}:${JSON.stringify(config)}`,
      };
    }

    const { config, sources } = mergePaypalConfigLayers({
      providerOptions: this.options,
    });

    return { config, sources, key: `0:${JSON.stringify(config)}` };
  }

  private async resolveClient(): Promise<{
    client: PaypalService;
    config: PaypalResolvedConfig;
    key: string;
  }> {
    const resolved = await this.resolveRuntimeConfig();

    assertPaypalConfigured(resolved.config);

    // #18 credential-environment guard: refuse to call PayPal with a
    // credential set declared for the other environment - both the module's
    // plugin-options declaration and this provider's own options declaration,
    // each meaningful while its layer supplies the active credentials. This
    // is the path that turned R11's sandbox-credentials-on-live delete into
    // an idempotent-looking 404.
    assertNoCredentialEnvironmentMismatch(
      resolved.moduleCredentialEnvironmentMismatch
    );
    assertNoCredentialEnvironmentMismatch(
      detectDeclaredCredentialEnvironmentMismatch({
        declaredEnvironment: this.options.credentialEnvironment,
        declaredLayer: "provider_options",
        sources: resolved.sources,
        resolvedIsSandbox: resolved.config.isSandbox,
      })
    );

    if (this.clientCache?.key === resolved.key) {
      return {
        client: this.clientCache.client,
        config: resolved.config,
        key: resolved.key,
      };
    }

    const client = new PaypalService(resolved.config);
    this.clientCache = { key: resolved.key, client };
    this.client = client;

    return { client, config: resolved.config, key: resolved.key };
  }

  /**
   * The single choke point every PayPal call goes through: resolves the
   * current config, refuses to run unconfigured (an empty-credential client
   * would surface as a confusing PayPal 401) and rebuilds the client whenever
   * the resolved config changed, so admin edits apply without a restart.
   */
  protected async getClient(): Promise<PaypalService> {
    return (await this.resolveClient()).client;
  }

  /**
   * Builds the subscription engine against the current configuration, wiring
   * whatever subscription collaborators the cradle carries. Returns undefined
   * for installs without the `dependencies` opt-in - every subscription entry
   * point surfaces a clear configuration error through the engine's `require`
   * helper. The engine is rebuilt whenever the resolved config changes:
   * autoBillOutstanding / paymentFailureThreshold are baked into its options
   * at construction, so a stale engine would silently ignore admin edits.
   */
  protected async getSubscriptionEngine(): Promise<
    SubscriptionEngine | undefined
  > {
    const cradle = this.containerRef;

    if (!cradle) {
      return undefined;
    }

    const { client, config, key } = await this.resolveClient();

    if (this.subscriptionEngineCache?.key === key) {
      return this.subscriptionEngineCache.engine;
    }

    const modules: SubscriptionEngineModules = { query: this.query };

    for (const moduleKey of SUBSCRIPTION_CRADLE_KEYS) {
      modules[moduleKey as "order"] = resolveOptionalCradleDependency(
        cradle as any,
        moduleKey
      );
    }

    /**
     * The subscription module, as this provider sees it: only the rail-event
     * hook is read from it here (the engine gets the module itself through
     * `modules["paypalSubscription"]`).
     */
    const subscriptionModule = modules["paypalSubscription"] as
      | { getNativeSubscriptionChangedHook?: () => NativeSubscriptionChangedHook | null }
      | undefined;

    const engineOptions: SubscriptionEngineOptions = {
      autoBillOutstanding: config.autoBillOutstanding,
      paymentFailureThreshold: config.paymentFailureThreshold,
      // The rail-event sink is read off the subscription module, not from this
      // provider's own options: the host wires `onNativeSubscriptionChanged`
      // once, on the plugin entry, and the module is the only party that always
      // sees it. A module that predates the hook (or a host that wired nothing)
      // answers `undefined`, and the engine then publishes nothing — the module
      // already warned about it at boot.
      onNativeSubscriptionChanged:
        subscriptionModule?.getNativeSubscriptionChangedHook?.() ?? undefined,
    };

    const engine = new SubscriptionEngine({
      client,
      logger: this.logger,
      eventBus: modules["event_bus"],
      subscriptionModule: modules["paypalSubscription"],
      productModule: modules["product"],
      orderModule: modules["order"],
      paymentModule: this.paymentModuleService,
      options: engineOptions,
    });

    this.subscriptionEngineCache = { key, engine };

    return engine;
  }

  static validateOptions(options: PaypalPluginOptionsType): void {
    const result = optionsSchema.safeParse(options);

    if (!result.success) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Invalid PayPal plugin options: ${result.error.message}`
      );
    }

    const hasClientId = providesCredential(result.data.clientId);
    const hasClientSecret = providesCredential(result.data.clientSecret);

    if (!hasClientId && !hasClientSecret) {
      // Zero-config install: the admin settings page can supply credentials
      // later, so an absent pair must not block boot.
      console.warn(
        "PayPal plugin is running unconfigured: no clientId/clientSecret were provided. " +
          "Set them on the admin PayPal settings page to enable PayPal payments."
      );
      return;
    }

    if (!hasClientId || !hasClientSecret) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Invalid PayPal plugin options: ${hasClientId ? "clientSecret" : "clientId"} is missing while the other credential is set. Provide both credentials or neither.`
      );
    }

    // #18 boot-time guard: an option layer that ships a credential pair must
    // declare it for the same environment it points isSandbox at. A
    // contradiction here is a hosting error that would otherwise surface as
    // confusing 401s (or R11's silent 404 deletes) on the wrong API.
    assertNoCredentialEnvironmentMismatch(
      detectDeclaredCredentialEnvironmentMismatch({
        declaredEnvironment: result.data.credentialEnvironment,
        declaredLayer: "self",
        sources: { clientId: "self", isSandbox: "self" },
        resolvedIsSandbox: result.data.isSandbox,
      })
    );
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

      const client = await this.getClient();
      const captured = await client.captureOrder(id);

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
      const engine = await this.getSubscriptionEngine();

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
      const client = await this.getClient();

      try {
        paypalData = await client.captureOrder(orderId);
      } catch (err) {
        const body = JSON.parse(err?.body || "{}");

        const captureData = body?.purchase_units?.[0]?.payments?.captures?.[0];

        const newOrder = await client.createOrder({
          amount: Number(amount),
          currency: currencyCode,
          fractionDigits: await getPaypalFractionDigits(
            this.query,
            currencyCode,
            this.logger
          ),
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
        // PayPal's declined capture reports the amount it was asked for
        // ("10.50"), which is already the major-unit number createOrder takes.
        const newOrder = await client.createOrder({
          amount: Number(captureData?.amount?.value),
          currency: captureData?.amount?.currencyCode!,
          fractionDigits: await getPaypalFractionDigits(
            this.query,
            captureData?.amount?.currencyCode!,
            this.logger
          ),
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
      const engine = await this.getSubscriptionEngine();

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

      const client = await this.getClient();
      const order = await client.createOrder({
        amount: Number(amount),
        currency: currency_code,
        fractionDigits: await getPaypalFractionDigits(
          this.query,
          currency_code,
          this.logger
        ),
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
        const engine = await this.getSubscriptionEngine();

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

      const client = await this.getClient();
      await client.refundPayment(captureIds);

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

  /**
   * Cancels whatever remote object the session created. Two session shapes are
   * not plain orders, and failing them bricked the whole cart in production
   * (MP-1: the 500 was Medusa core's `Could not delete all payment sessions`,
   * raised because this method threw):
   *
   * - A native subscription session carries `paypal_subscription_id` (and
   *   `is_subscription`) instead of an order id. Its billing subscription is
   *   cancelled best-effort: the customer abandoned the approval page, so the
   *   resource is frequently already gone at PayPal (404
   *   `INVALID_RESOURCE_ID` for an unapproved subscription) and the local
   *   delete must not block on that.
   * - A session that never created an order at all (`data.id` absent) has
   *   nothing remote to void. Having nothing to delete is not an error.
   *
   * The subscription cancel goes straight to the billing client instead of the
   * subscription engine's `requestLifecycleAction`: that path owns rows that
   * exist and emits customer-facing cancellation events, while this is
   * pre-approval cleanup - and the provider stays usable on hosts that never
   * register the subscription module. The two paths are told apart by their
   * PayPal-visible reason: engine cancellations say "Managed via Medusa",
   * abandoned-checkout cleanups say "Abandoned checkout".
   */
  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    const nonEmptyString = (value: unknown): string | undefined =>
      typeof value === "string" && value ? value : undefined;

    try {
      if (!input.data) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          "Payment data is required"
        );
      }

      const sessionData = input.data as Record<string, unknown>;

      const subscriptionId =
        nonEmptyString(sessionData.paypal_subscription_id) ??
        (sessionData.is_subscription === true
          ? nonEmptyString(sessionData.id)
          : undefined);

      if (subscriptionId) {
        try {
          const client = await this.getClient();

          await client.subscriptionAction(
            subscriptionId,
            "cancel",
            "Abandoned checkout"
          );
        } catch (cancelError) {
          // Best effort by design: an unapproved subscription expires on its
          // own, and a delete that throws here takes the cart down with it.
          this.logger.warn(
            `PayPal subscription cancel during delete skipped (${subscriptionId}): ${String(
              cancelError
            )}`
          );
        }

        return {
          data: {
            subscription_id: subscriptionId,
            status: PaymentSessionStatus.CANCELED,
            cancelled_at: new Date().toISOString(),
          },
        };
      }

      const orderId = nonEmptyString(sessionData.id);

      if (!orderId) {
        return {
          data: {
            status: PaymentSessionStatus.CANCELED,
            cancelled_at: new Date().toISOString(),
          },
        };
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
   * server-side holder entity: the Medusa customer id is the merchant-side
   * customer id the provider derives a 22-character id from, and only that
   * derived id is sent to PayPal as `customer.id` - the id PayPal's
   * payment-token list endpoint resolves by. The merchant id itself never
   * reaches PayPal.
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
   * holder's external id is the merchant-side customer id the derived PayPal
   * customer id is computed from; the wallets themselves are associated with
   * that derived id.
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

    const client = await this.getClient();
    const tokens = await client.listVaultedPaymentMethods(
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
   * Deletes a vaulted PayPal wallet for the account holder carried by the
   * context. The id is never trusted on its own: it must appear in the
   * holder's own vaulted tokens first, so this can never become a blind
   * delete-by-id primitive for another customer's wallet (IDOR). A token
   * already gone at PayPal is the desired end state, so the delete is
   * idempotent.
   *
   * The token id is a secret: the failure raised for an unowned id carries no
   * id, and the PayPal call's own failures are sanitized by
   * `toVaultFailure` - neither the response nor a log line may echo it.
   */
  async deletePaymentMethod(
    input: DeletePaymentMethodInput
  ): Promise<DeletePaymentMethodOutput> {
    const id = input.data?.id;

    if (!id) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "A payment method id is required"
      );
    }

    const externalId = readAccountHolderExternalId(input.context);

    if (!externalId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Deleting a payment method requires an account holder"
      );
    }

    const client = await this.getClient();
    const tokens = await client.listVaultedPaymentMethods(String(externalId));

    if (!tokens.some((token) => token.id === id)) {
      throw new MedusaError(
        MedusaError.Types.NOT_FOUND,
        "Payment method not found for this account holder"
      );
    }

    await client.deleteVaultedPaymentMethod(id);

    return {};
  }

  /**
   * Verifies a webhook signature against the primary webhook id, falling
   * back to the subscription webhook id when one is configured - events
   * delivered on the second webhook are signed with its id, so verification
   * must try both to keep mixed topologies working. Both ids come from the
   * resolved config so admin edits apply immediately.
   */
  private async verifyWebhookSignature(
    headers: Record<string, string>,
    body: object
  ): Promise<void> {
    const { client, config } = await this.resolveClient();

    try {
      await client.verifyWebhook({ headers, body });
      return;
    } catch (error) {
      if (!config.subscriptionWebhookId) {
        throw error;
      }

      await client.verifyWebhook({
        headers,
        body,
        webhookId: config.subscriptionWebhookId,
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

      const client = await this.getClient();
      const order = await client.retrieveOrder(order_id);

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
        const engine = await this.getSubscriptionEngine();

        if (!engine) {
          throw new MedusaError(
            MedusaError.Types.INVALID_DATA,
            "PayPal subscriptions are not configured"
          );
        }

        const subscriptionId =
          (sessionData.paypal_subscription_id as string) ?? id;
        const client = await this.getClient();
        const subscription = await client.getSubscription(subscriptionId);

        return { data: { response: subscription } };
      }

      const client = await this.getClient();
      const res = await client.retrieveOrder(id);
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
    const engine = await this.getSubscriptionEngine();

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
      const client = await this.getClient();
      order = await client.createOrder({
        amount,
        currency: currencyCode,
        fractionDigits: await getPaypalFractionDigits(
          this.query,
          currencyCode,
          this.logger
        ),
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
