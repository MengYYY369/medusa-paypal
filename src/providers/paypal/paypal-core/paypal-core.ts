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
          value: this.toMajorUnits(item.unit_price),
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

  public verifyWebhook = async ({
    headers,
    body,
  }: {
    headers: Record<string, string>;
    body: object;
  }): Promise<{ body: object; status: "SUCCESS" | "FAILURE" }> => {
    if (!this.webhookId) {
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
          webhook_id: this.webhookId,
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
    return (minor / 100).toFixed(2);
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
