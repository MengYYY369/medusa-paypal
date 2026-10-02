import {
  CheckoutPaymentIntent,
  Client,
  Environment,
  OAuthAuthorizationController,
  Order,
  OrderAuthorizeResponse,
  OrdersController,
  PaymentsController,
  PaypalPaymentTokenUsageType,
  PaymentSource,
  PaymentTokenResponse,
  Refund,
  Item,
  ShippingDetails,
  OrderApplicationContextShippingPreference,
  OrderApplicationContextUserAction,
  FulfillmentType,
  LinkDescription,
  PaymentTokenStatus,
  StoreInVaultInstruction,
  VaultController,
  VaultInstructionAction,
  VaultTokenRequestType,
} from "@paypal/paypal-server-sdk";
import { CartAddressDTO, CartLineItemDTO } from "@medusajs/framework/types";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { createHash } from "node:crypto";
import { PaypalPluginOptionsType } from "../service";
import { MedusaError } from "@medusajs/framework/utils";

export interface PaypalCreateOrderInput {
  amount: number;
  currency: string;
  /** Fraction digits of `currency`; PayPal rejects mis-scaled amounts. */
  fractionDigits: number;
  sessionId?: string;
  shipping_info?: CartAddressDTO;
  items?: CartLineItemDTO[];
  email?: string;
  /** PayPal v3 payment-token id to charge off-session (merchant-initiated). */
  vaultId?: string;
  /**
   * Opt in to saving the PayPal wallet on successful checkout, associated
   * with the given merchant-side customer id.
   */
  vaultCustomerId?: string;
  /**
   * Required by PayPal whenever the order vaults a payment source
   * (RETURN_URL_REQUIRED / CANCEL_URL_REQUIRED). Only read for CIT flows —
   * merchant-initiated (vaultId) orders never show an approval page.
   */
  return_url?: string;
  cancel_url?: string;
}

/**
 * PayPal amounts are decimal major-unit strings written with the currency's
 * own fraction digits. Medusa hands the provider major units too, so this is
 * formatting only - never scale the number here. Exported because the
 * subscription engine builds plan/charge payloads outside this class as well.
 */
export function formatPaypalAmount(major: number, fractionDigits: number): string {
  return major.toFixed(fractionDigits)
}

/**
 * Bridges a merchant-side customer id to the id PayPal's Vault v3 API
 * resolves by. `customer.id` is merchant-supplied and capped at 22 characters
 * (`[0-9a-zA-Z_-]`), while Medusa customer ids are 30 (`cus_` + a 26-char
 * ULID), so the merchant id cannot be sent as-is. Hashing is deterministic:
 * every instance derives the same value with no storage and no migration.
 */
export function derivePaypalCustomerId(merchantCustomerId: string): string {
  return createHash("sha256").update(merchantCustomerId).digest("base64url").slice(0, 22);
}

export interface PaypalBillingProductInput {
  name: string;
  type: "SERVICE" | "PHYSICAL" | "DIGITAL";
  description?: string;
}

export interface PaypalBillingCycleInput {
  frequency: { interval_unit: string; interval_count: number };
  tenure_type: "TRIAL" | "REGULAR";
  sequence: number;
  total_cycles: number;
  pricing_scheme: { fixed_price: { value: string; currency_code: string } };
  billing_preferences?: {
    setup_fee?: { value: string; currency_code: string };
    auto_bill_outstanding?: boolean;
  };
}

export interface PaypalBillingPlanInput {
  product_id: string;
  name: string;
  billing_cycles: PaypalBillingCycleInput[];
  auto_bill_outstanding?: boolean;
  payment_failure_threshold?: number;
}

export interface PaypalCreateSubscriptionInput {
  plan_id: string;
  custom_id: string;
  email?: string;
  return_url?: string;
  cancel_url?: string;
}

export interface PaypalSubscriptionResponse {
  id: string;
  status: string;
  status_update_time?: string;
  billing_info?: {
    next_billing_time?: string;
    last_payment?: { time?: string; amount?: { value: string; currency_code: string } };
    failed_payments_count?: number;
    next_billing_amount?: { value: string; currency_code: string };
  };
  subscriber?: { email_address?: string; payer_id?: string };
  links?: { rel: string; href: string; method?: string }[];
}

export interface PaypalSaleResponse {
  id: string;
  status: string;
  amount?: { value: string; currency_code: string };
  billing_agreement_id?: string;
  custom_id?: string;
}

export interface PaypalCaptureResponse {
  id: string;
  status: string;
  amount?: { value: string; currency_code: string };
  billing_agreement_id?: string;
  custom_id?: string;
}

export interface PaypalTransactionResponse {
  id: string;
  status: string;
  amount?: { value: string; currency_code: string };
  time: string;
}

export interface PaypalVaultSetupTokenInput {
  customer_id: string;
  return_url: string;
  cancel_url: string;
}

export interface PaypalVaultSetupTokenStart {
  setup_token_id: string;
  approve_url: string;
}

export interface PaypalVaultSetupTokenState {
  setup_token_id: string;
  status: string;
  approve_url?: string;
}

export interface PaypalVaultPaymentToken {
  vault_id: string;
}

/** The parts of a PayPal REST error body that are safe to surface. */
type PaypalErrorBody = {
  name?: string;
  details?: { issue?: string }[];
};

/**
 * Pulls the HTTP status and the PayPal issue/name code out of an SDK error.
 * Mirrors extractPaypalDecline in service.ts (`error.result ?? error.body`,
 * string bodies parsed as JSON) but deliberately drops the
 * `description`/`message`: PayPal echoes ids (setup token, vault id) into
 * those, and this text reaches logs and API responses.
 */
function extractPaypalErrorCode(error: unknown): {
  status?: number;
  code?: string;
} {
  if (error === null || typeof error !== "object") {
    return {};
  }

  const candidate = error as {
    statusCode?: unknown;
    body?: unknown;
    result?: unknown;
  };
  const raw = candidate.result ?? candidate.body;

  let body: PaypalErrorBody | undefined;

  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw) as PaypalErrorBody;
    } catch {
      body = undefined;
    }
  } else if (raw !== null && typeof raw === "object") {
    body = raw as PaypalErrorBody;
  }

  return {
    status:
      typeof candidate.statusCode === "number" ? candidate.statusCode : undefined,
    code: body?.details?.[0]?.issue ?? body?.name,
  };
}

/**
 * Translates a vault SDK/upstream failure into UNEXPECTED_STATE so the
 * subscription engine's classifier renders a 500: it preserves only
 * not_found / invalid_data / not_allowed / conflict / duplicate_error /
 * payment_authorization_error, so an upstream vault fault must never be
 * laundered into a fabricated 400 customer refusal.
 */
function toVaultFailure(operation: string, error: unknown): MedusaError {
  const { status, code } = extractPaypalErrorCode(error);
  const detail = [status !== undefined ? `HTTP ${status}` : undefined, code]
    .filter((part): part is string => !!part)
    .join(", ");

  return new MedusaError(
    MedusaError.Types.UNEXPECTED_STATE,
    detail
      ? `PayPal vault ${operation} failed (${detail})`
      : `PayPal vault ${operation} failed`,
  );
}

/** Runs one vault SDK call, converting any rejection into a MedusaError. */
async function callVaultApi<T>(
  operation: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toVaultFailure(operation, error);
  }
}

/**
 * Approval link of a setup token. The sandbox harness reads `approve` first
 * and falls back to `payer-action`; both relations appear in live responses.
 */
function extractApproveUrl(
  links: LinkDescription[] | undefined,
): string | undefined {
  const link =
    links?.find((candidate) => candidate.rel === "approve") ??
    links?.find((candidate) => candidate.rel === "payer-action");

  return link?.href;
}

/**
 * PayPal requires absolute http(s) return/cancel URLs on vault flows
 * (RETURN_URL_REQUIRED / CANCEL_URL_REQUIRED otherwise). A bad value is a
 * caller bug, so it is rejected here - before any network call - as
 * INVALID_DATA and must not be reported as an upstream vault failure.
 */
function assertAbsoluteHttpUrl(field: string, value: string): void {
  let parsed: URL | undefined;

  try {
    parsed = new URL(value);
  } catch {
    parsed = undefined;
  }

  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Invalid ${field}: expected an absolute http(s) URL`,
    );
  }
}

export class PaypalService {
  /**
   * Environment this client was built for. Public because plan hashing must
   * differ per environment - a plan minted in sandbox is not reusable in live.
   */
  public readonly environment: "sandbox" | "live";
  private client: Client;
  private ordersController: OrdersController;
  private paymentsController: PaymentsController;
  private vaultController: VaultController;
  private authController: OAuthAuthorizationController;
  private clientId: string;
  private clientSecret: string;
  private webhookId: string | undefined;
  private includeShippingData: boolean;
  private includeCustomerData: boolean;
  /**
   * Environment-specific REST base. Public because the client-token route
   * needs the same origin and must not re-derive the environment itself.
   */
  public readonly baseUrl: string;

  constructor({
    clientId,
    clientSecret,
    isSandbox,
    webhookId,
    includeCustomerData,
    includeShippingData,
  }: PaypalPluginOptionsType) {
    const environment = isSandbox
      ? Environment.Sandbox
      : Environment.Production;

    // Optional credentials land here as "" when the plugin boots
    // unconfigured; runtime calls are guarded by `assertPaypalConfigured`.
    const effectiveClientId = clientId ?? "";
    const effectiveClientSecret = clientSecret ?? "";

    this.client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: effectiveClientId,
        oAuthClientSecret: effectiveClientSecret,
      },
      timeout: 0,
      environment,
      // No `logging` key on purpose: supplying one makes the SDK build its
      // ConsoleLogger, which prints the request URL line - and the setup
      // token lookup is `GET /v3/vault/setup-tokens/{id}`, so the id would
      // reach stdout on every approval check. Request bodies carry vault ids
      // and setup token ids too. Left unset, the SDK merges its own defaults,
      // whose logger is a NullLogger that emits nothing.
    });

    this.baseUrl = isSandbox
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com";

    this.clientId = effectiveClientId;
    this.clientSecret = effectiveClientSecret;
    this.webhookId = webhookId;
    this.environment = isSandbox ? "sandbox" : "live";

    this.ordersController = new OrdersController(this.client);
    this.paymentsController = new PaymentsController(this.client);
    this.vaultController = new VaultController(this.client);
    this.authController = new OAuthAuthorizationController(this.client);

    this.includeCustomerData = !!includeCustomerData;
    this.includeShippingData = !!includeShippingData;
  }

  async getAccessToken(): Promise<string> {
    try {
      const authorization = Buffer.from(
        `${this.clientId}:${this.clientSecret}`,
      ).toString("base64");

      const authRes = await this.authController.requestToken({
        authorization: `Basic ${authorization}`,
      });

      const accessToken = authRes.result.accessToken;

      if (!accessToken) throw new Error("Failed to get access token");

      return accessToken;
    } catch (error) {
      throw new Error(`Failed to get access token: ${JSON.stringify(error)}`);
    }
  }

  async createOrder({
    amount,
    currency,
    fractionDigits,
    sessionId,
    shipping_info,
    items,
    email,
    vaultId,
    vaultCustomerId,
    return_url,
    cancel_url,
  }: PaypalCreateOrderInput): Promise<Order> {
    const ordersController = new OrdersController(this.client);

    const paypalItems: Item[] =
      items?.map((item) => ({
        name: item.title,
        quantity: item.quantity.toString(),
        unitAmount: {
          currencyCode: currency,
          value: formatPaypalAmount(Number(item.unit_price), fractionDigits),
        },
      })) || [];

    const hasItems = paypalItems.length > 0;

    const paymentSource: PaymentSource | undefined = vaultId
      ? { paypal: { vaultId } }
      : vaultCustomerId
        ? {
            paypal: {
              attributes: {
                vault: {
                  storeInVault: StoreInVaultInstruction.OnSuccess,
                  usageType: PaypalPaymentTokenUsageType.Merchant,
                  permitMultiplePaymentTokens: true,
                },
                // Orders v2 treats `customer.id` and
                // `customer.merchant_customer_id` as mutually exclusive: sending
                // both is rejected with `422 INCOMPATIBLE_PARAMETER_VALUE`
                // (both fields flagged). Like the vault-approval path
                // (`createVaultSetupToken`), this path sends only the derived
                // id; the merchant id is never sent to PayPal.
                customer: {
                  id: derivePaypalCustomerId(vaultCustomerId),
                },
              },
            },
          }
        : undefined;

    const shippingData: ShippingDetails | false = !!shipping_info && {
      ...(this.includeCustomerData &&
        this.mapCustomerData({ email, shipping_info })),
      ...(this.includeShippingData && this.mapShippingData(shipping_info)),
      type: FulfillmentType.Shipping,
    };

    const createdOrder = await ordersController.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        ...(paymentSource && { paymentSource }),
        purchaseUnits: [
          {
            amount: {
              currencyCode: currency,
              value: formatPaypalAmount(amount, fractionDigits),
              ...(hasItems && {
                breakdown: {
                  itemTotal: {
                    currencyCode: currency,
                    value: formatPaypalAmount(amount, fractionDigits),
                  },
                },
              }),
            },
            customId: sessionId,
            ...(hasItems && { items: paypalItems }),
            ...(shippingData && { shipping: shippingData }),
          },
        ],
        // Approval experience is only meaningful when a buyer is present;
        // off-session vault charges must not request payer action. PayPal
        // REQUIRES return_url/cancel_url on any order that vaults a source
        // (422 RETURN_URL_REQUIRED / CANCEL_URL_REQUIRED otherwise).
        ...(vaultId
          ? {}
          : {
              applicationContext: {
                ...(return_url && { returnUrl: return_url }),
                ...(cancel_url && { cancelUrl: cancel_url }),
                ...(this.includeShippingData &&
                  shippingData && {
                    shippingPreference:
                      OrderApplicationContextShippingPreference.SetProvidedAddress,
                  }),
                userAction: OrderApplicationContextUserAction.PayNow,
              },
            }),
      },
      // Charging a vaulted token (off-session MIT) requires PayPal-Request-Id
      // (error PAYPAL_REQUEST_ID_REQUIRED otherwise); the session id makes
      // retries idempotent, a fresh UUID guards the no-session case.
      ...(vaultId
        ? { paypalRequestId: sessionId ?? this.newRequestId() }
        : {}),
    });

    if (!createdOrder?.result?.id) throw new Error("Failed to create order");

    return createdOrder.result;
  }

  async captureOrder(id: string): Promise<Order> {
    const capturedOrder = await this.ordersController.captureOrder({
      id,
    });

    return capturedOrder.result;
  }

  async retrieveOrder(id: string): Promise<Order> {
    const orderDetails = await this.ordersController.getOrder({
      id,
    });

    return orderDetails.result;
  }

  async authorizeOrder(id: string): Promise<OrderAuthorizeResponse> {
    const authorizedOrder = await this.ordersController.authorizeOrder({
      id,
    });

    return authorizedOrder.result;
  }

  /**
   * Lists the vaulted PayPal wallets of a customer. `customerId` is the
   * merchant-side customer id the wallet was saved with; PayPal's list
   * endpoint resolves by its own `customer.id`, so the merchant id is derived
   * into the 22-character id the vault flows send as `customer.id`.
   */
  async listVaultedPaymentMethods(
    customerId: string
  ): Promise<PaymentTokenResponse[]> {
    try {
      const response = await this.vaultController.listCustomerPaymentTokens({
        customerId: derivePaypalCustomerId(customerId),
      });

      return response.result.paymentTokens ?? [];
    } catch (error) {
      // D9 fail-soft: the derived id is always 22 characters, so a 404 can
      // only mean "this customer has no vaulted tokens" (a valid-length id
      // that matches nothing). A 400 (INVALID_STRING_LENGTH) can no longer
      // occur legitimately and must stay an error, as must every other
      // status.
      const { status, code } = extractPaypalErrorCode(error);

      if (status === 404 && code === "CUSTOMER_ID_NOT_FOUND") {
        return [];
      }

      throw error;
    }
  }

  /**
   * Creates a Vault v3 setup token for a customer's PayPal wallet. The
   * caller's customer id is a merchant-side id: `derivePaypalCustomerId`
   * turns it into the 22-character id sent as the top-level `customer.id` - a
   * sibling of `paymentSource`, because the wallet request object has no
   * customer member. The derived id is the only customer identifier sent; the
   * merchant id stays on our side and never reaches PayPal. The merchant id
   * cannot be sent alongside either: PayPal fixes a customer record's
   * `customer.id` at the first `merchant_customer_id` association and ignores
   * a later derived id, so a token minted that way would not be listable by
   * the derived id. Returns the setup token id plus the payer-approval link
   * the storefront must send the buyer to. `permitMultiplePaymentTokens: true`
   * mints a token per customer rather than reusing the payer's existing one,
   * so the token carries this customer's id instead of a previously vaulted
   * customer's.
   */
  async createVaultSetupToken(
    input: PaypalVaultSetupTokenInput,
  ): Promise<PaypalVaultSetupTokenStart> {
    assertAbsoluteHttpUrl("return_url", input.return_url);
    assertAbsoluteHttpUrl("cancel_url", input.cancel_url);

    const response = await callVaultApi("create setup token", () =>
      this.vaultController.createSetupToken({
        body: {
          customer: { id: derivePaypalCustomerId(input.customer_id) },
          paymentSource: {
            paypal: {
              usageType: PaypalPaymentTokenUsageType.Merchant,
              permitMultiplePaymentTokens: true,
              experienceContext: {
                returnUrl: input.return_url,
                cancelUrl: input.cancel_url,
                vaultInstruction: VaultInstructionAction.OnPayerApproval,
              },
            },
          },
        },
      }),
    );

    const setupTokenId = response.result.id;
    const approveUrl = extractApproveUrl(response.result.links);

    if (!setupTokenId || !approveUrl) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `PayPal vault setup token response is missing the ${
          setupTokenId ? "payer approval link" : "setup token id"
        }`,
      );
    }

    return { setup_token_id: setupTokenId, approve_url: approveUrl };
  }

  /**
   * Reads a setup token's state back from PayPal. The status is surfaced as a
   * plain string: sandbox reports VAULTED (not APPROVED) once the payer has
   * approved, so APPROVED / VAULTED / TOKENIZED are treated as exchangeable
   * by the caller.
   */
  async getVaultSetupToken(id: string): Promise<PaypalVaultSetupTokenState> {
    const response = await callVaultApi("get setup token", () =>
      this.vaultController.getSetupToken(id),
    );

    const status: PaymentTokenStatus | undefined = response.result.status;
    const approveUrl = extractApproveUrl(response.result.links);

    if (!status) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "PayPal vault setup token response is missing the status",
      );
    }

    return {
      setup_token_id: response.result.id ?? id,
      status,
      ...(approveUrl && { approve_url: approveUrl }),
    };
  }

  /**
   * Exchanges an approved setup token for a permanent Vault v3 payment token.
   * The returned id is the payment-method reference the subscription engine
   * stores and later charges off-session.
   */
  async createVaultPaymentToken(
    setupTokenId: string,
  ): Promise<PaypalVaultPaymentToken> {
    const response = await callVaultApi("create payment token", () =>
      this.vaultController.createPaymentToken({
        body: {
          paymentSource: {
            token: {
              id: setupTokenId,
              type: VaultTokenRequestType.SetupToken,
            },
          },
        },
      }),
    );

    const vaultId = response.result.id;

    if (!vaultId) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "PayPal vault payment token response is missing the payment token id",
      );
    }

    return { vault_id: vaultId };
  }

  /**
   * Deletes a vaulted payment token. A 404 is treated as success: the desired
   * end state is "no such token", so a retried unbind stays idempotent. Every
   * other failure is sanitized by `toVaultFailure` - the token id is a secret
   * PayPal echoes into error descriptions, so only the HTTP status and issue
   * code may reach the caller or the logs.
   */
  async deleteVaultedPaymentMethod(id: string): Promise<void> {
    try {
      await this.vaultController.deletePaymentToken(id);
    } catch (error) {
      const { status } = extractPaypalErrorCode(error);

      if (status === 404) {
        return;
      }

      throw toVaultFailure("delete payment token", error);
    }
  }

  async refundPayment(captureIds: string[]): Promise<Refund[]> {
    const refunds: Refund[] = [];

    for (const captureId of captureIds) {
      const refund = await this.paymentsController.refundCapturedPayment({
        captureId,
      });

      refunds.push(refund.result);
    }

    return refunds;
  }

  /**
   * Raw JSON request against the PayPal REST API. Used for the Billing
   * endpoints the official SDK controllers do not cover (products, plans,
   * subscriptions, sale refunds) - same access-token path as verifyWebhook.
   */
  private async billingRequest<T>(
    method: "GET" | "POST" | "PUT" | "PATCH",
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const accessToken = await this.getAccessToken();

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        ...(method === "POST" && { "PayPal-Request-Id": this.newRequestId() }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

    const text = await response.text();
    let data: any = undefined;

    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }

    if (!response.ok) {
      const detail = data?.details?.[0];
      const error = new Error(
        `PayPal ${method} ${path} failed (${response.status}): ${
          data?.message ?? response.statusText
        }${detail?.issue ? ` [${detail.issue}]` : ""}`
      ) as Error & { paypalStatus?: number; paypalIssue?: string };

      error.paypalStatus = response.status;
      error.paypalIssue = detail?.issue ?? data?.name;

      throw error;
    }

    return data as T;
  }

  async createBillingProduct(
    input: PaypalBillingProductInput
  ): Promise<{ id: string }> {
    // Catalog Products API - products live under /v1/catalogs (plans and
    // subscriptions are the ones under /v1/billing).
    return this.billingRequest<{ id: string }>("POST", "/v1/catalogs/products", {
      name: input.name,
      type: input.type,
      ...(input.description && { description: input.description }),
    });
  }

  async createBillingPlan(
    input: PaypalBillingPlanInput
  ): Promise<{ id: string }> {
    return this.billingRequest<{ id: string }>("POST", "/v1/billing/plans", {
      product_id: input.product_id,
      name: input.name,
      status: "ACTIVE",
      billing_cycles: input.billing_cycles,
      payment_preferences: {
        auto_bill_outstanding: input.auto_bill_outstanding ?? true,
        ...(input.payment_failure_threshold != null && {
          payment_failure_threshold: input.payment_failure_threshold,
        }),
      },
    });
  }

  async getBillingPlan(id: string): Promise<{ id: string; status: string }> {
    return this.billingRequest<{ id: string; status: string }>(
      "GET",
      `/v1/billing/plans/${encodeURIComponent(id)}`
    );
  }

  async createSubscription(
    input: PaypalCreateSubscriptionInput
  ): Promise<PaypalSubscriptionResponse> {
    return this.billingRequest<PaypalSubscriptionResponse>(
      "POST",
      "/v1/billing/subscriptions",
      {
        plan_id: input.plan_id,
        custom_id: input.custom_id,
        ...(input.email && { subscriber: { email_address: input.email } }),
        application_context: {
          ...(input.return_url && { return_url: input.return_url }),
          ...(input.cancel_url && { cancel_url: input.cancel_url }),
          shipping_preference: "NO_SHIPPING",
          user_action: "SUBSCRIBE_NOW",
        },
      }
    );
  }

  async getSubscription(id: string): Promise<PaypalSubscriptionResponse> {
    return this.billingRequest<PaypalSubscriptionResponse>(
      "GET",
      `/v1/billing/subscriptions/${encodeURIComponent(id)}`
    );
  }

  async subscriptionAction(
    id: string,
    action: "suspend" | "activate" | "cancel",
    reason?: string
  ): Promise<void> {
    await this.billingRequest<unknown>(
      "POST",
      `/v1/billing/subscriptions/${encodeURIComponent(id)}/${action}`,
      { reason: reason ?? "Managed via Medusa" }
    );
  }

  async listSubscriptionTransactions(
    id: string,
    startTime: string,
    endTime: string
  ): Promise<PaypalTransactionResponse[]> {
    const result = await this.billingRequest<{ transactions?: PaypalTransactionResponse[] }>(
      "GET",
      `/v1/billing/subscriptions/${encodeURIComponent(id)}/transactions?start_time=${encodeURIComponent(
        startTime
      )}&end_time=${encodeURIComponent(endTime)}`
    );

    return result.transactions ?? [];
  }

  async getSale(saleId: string): Promise<PaypalSaleResponse> {
    return this.billingRequest<PaypalSaleResponse>(
      "GET",
      `/v1/payments/sales/${encodeURIComponent(saleId)}`
    );
  }

  /**
   * Refunds a subscription-period sale (v1 sale refund, NOT the Orders v2
   * capture refund used by refundPayment). Refunding an already fully
   * refunded sale surfaces as paypalIssue REFUND_ISSUE_* from billingRequest.
   */
  async refundSale(
    saleId: string,
    amount?: { value: string; currency_code: string },
    note?: string
  ): Promise<{ id: string; status: string }> {
    return this.billingRequest<{ id: string; status: string }>(
      "POST",
      `/v1/payments/sales/${encodeURIComponent(saleId)}/refund`,
      {
        ...(amount && { amount }),
        ...(note && { note }),
      }
    );
  }

  /**
   * Fetches a subscription-period charge. The current subscriptions platform
   * records charges as Orders v2 captures even though the webhooks keep the
   * legacy PAYMENT.SALE.* names - the ids surfaced by subscriptions
   * transactions and webhooks resolve here (v1 sales only exist for legacy
   * billing agreements). Refund callers should try this first and fall back
   * to getSale on a 404.
   */
  async getCapture(captureId: string): Promise<PaypalCaptureResponse> {
    return this.billingRequest<PaypalCaptureResponse>(
      "GET",
      `/v2/payments/captures/${encodeURIComponent(captureId)}`
    );
  }

  /**
   * Refunds a subscription-period charge on the v2 capture rail. Omitting
   * the amount refunds the full remaining balance (correct after partial
   * refunds, where the gross amount exceeds what is still refundable).
   */
  async refundCapture(
    captureId: string,
    amount?: { value: string; currency_code: string },
    note?: string
  ): Promise<{ id: string; status: string }> {
    return this.billingRequest<{ id: string; status: string }>(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        ...(amount && { amount }),
        ...(note && { note_to_payer: note }),
      }
    );
  }

  public verifyWebhook = async ({
    headers,
    body,
    webhookId,
  }: {
    headers: Record<string, string>;
    body: object;
    /** Overrides the configured webhook id (second-webhook topology). */
    webhookId?: string;
  }): Promise<{ body: object; status: "SUCCESS" | "FAILURE" }> => {
    const effectiveWebhookId = webhookId ?? this.webhookId;

    if (!effectiveWebhookId) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "Webhook ID is not set",
      );
    }

    const accessToken = await this.getAccessToken();

    const verifyWebhookRes = await fetch(
      `${this.baseUrl}/v1/notifications/verify-webhook-signature`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          auth_algo: headers["paypal-auth-algo"],
          cert_url: headers["paypal-cert-url"],
          transmission_id: headers["paypal-transmission-id"],
          transmission_sig: headers["paypal-transmission-sig"],
          transmission_time: headers["paypal-transmission-time"],
          webhook_id: effectiveWebhookId,
          webhook_event: body,
        }),
      },
    );

    if (!verifyWebhookRes.ok) {
      throw new Error(
        `Failed to verify webhook signature: ${verifyWebhookRes.statusText}`,
      );
    }

    const verifyWebhookData = await verifyWebhookRes.json();

    if (verifyWebhookData.verification_status !== "SUCCESS") {
      throw new Error("Failed to verify webhook signature");
    }

    return { status: verifyWebhookData.verification_status, body };
  };

  private newRequestId(): string {
    return globalThis.crypto.randomUUID();
  }

  private mapCustomerData({
    email,
    shipping_info,
  }: {
    email?: string;
    shipping_info: PaypalCreateOrderInput["shipping_info"];
  }):
    | Pick<ShippingDetails, "name" | "emailAddress" | "phoneNumber">
    | undefined {
    if (!this.includeCustomerData || !shipping_info) {
      return undefined;
    }

    const parsedPhoneNumber =
      !!shipping_info?.phone && parsePhoneNumberFromString(shipping_info.phone);

    return {
      name: {
        fullName: `${shipping_info.first_name} ${shipping_info.last_name}`,
      },
      ...(email && { emailAddress: email }),
      ...(parsedPhoneNumber && {
        phoneNumber: {
          countryCode: parsedPhoneNumber.countryCallingCode,
          nationalNumber: parsedPhoneNumber.nationalNumber,
        },
      }),
    };
  }

  private mapShippingData(
    shipping_info: PaypalCreateOrderInput["shipping_info"],
  ): Pick<ShippingDetails, "address"> | undefined {
    if (
      !this.includeShippingData ||
      !shipping_info ||
      !shipping_info.country_code
    ) {
      return undefined;
    }

    return {
      address: {
        countryCode: shipping_info.country_code,
        postalCode: shipping_info.postal_code,
        adminArea1: shipping_info.province,
        adminArea2: shipping_info.city,
        addressLine1: shipping_info.address_1,
      },
    };
  }
}
