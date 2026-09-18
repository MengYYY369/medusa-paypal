import {
  CheckoutPaymentIntent,
  Client,
  Environment,
  LogLevel,
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
  StoreInVaultInstruction,
  VaultController,
} from "@paypal/paypal-server-sdk";
import { CartAddressDTO, CartLineItemDTO } from "@medusajs/framework/types";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { PaypalPluginOptionsType } from "../service";
import { MedusaError } from "@medusajs/framework/utils";

export interface PaypalCreateOrderInput {
  amount: number;
  currency: string;
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
 * Medusa amounts are integer minor units; PayPal billing API amounts are
 * decimal major-unit strings. Exported because the subscription engine
 * builds plan/charge payloads outside this class as well.
 */
export function toPaypalMajorAmount(minor: number): string {
  return (minor / 100).toFixed(2);
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

export interface PaypalTransactionResponse {
  id: string;
  status: string;
  amount?: { value: string; currency_code: string };
  time: string;
}

export class PaypalService {
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
  private baseUrl: string;

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

    this.client = new Client({
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
      },
      timeout: 0,
      environment,
      logging: {
        logLevel: LogLevel.Info,
        logRequest: {
          logBody: true,
        },
        logResponse: {
          logHeaders: true,
        },
      },
    });

    this.baseUrl = isSandbox
      ? "https://api-m.sandbox.paypal.com"
      : "https://api-m.paypal.com";

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.webhookId = webhookId;

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
          value: this.toMajorUnits(Number(item.unit_price)),
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
                },
                customer: { merchantCustomerId: vaultCustomerId },
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
              value: this.toMajorUnits(amount),
              ...(hasItems && {
                breakdown: {
                  itemTotal: {
                    currencyCode: currency,
                    value: this.toMajorUnits(amount),
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
   * merchant-side customer id that was associated with the wallet when it
   * was saved (merchant_customer_id at vault time).
   */
  async listVaultedPaymentMethods(
    customerId: string
  ): Promise<PaymentTokenResponse[]> {
    const response = await this.vaultController.listCustomerPaymentTokens({
      customerId,
    });

    return response.result.paymentTokens ?? [];
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
    return this.billingRequest<{ id: string }>("POST", "/v1/billing/products", {
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

  /**
   * Medusa v2 exchanges amounts in integer minor units; PayPal order amounts
   * are decimal major units. A $9.90 product arrives as 990 → "9.90" here.
   */
  private toMajorUnits(minor: number): string {
    return toPaypalMajorAmount(minor);
  }

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
