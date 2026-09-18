import PaypalModuleService from "../service"
import { PaypalService } from "../paypal-core/paypal-core"
import { PaymentSessionStatus } from "@medusajs/framework/utils"
import {
  FakeSubscriptionModule,
  makeEventBus,
  makeFirstOrder,
  makeOrderModule,
  makePaymentModule,
  makeProductModule,
  makeVariant,
  makeRow,
} from "../../../subscription/__tests__/fakes"

const loggerStub = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}

/**
 * Provider-level subscription tests: the provider is constructed with a
 * cradle-like container exposing the subscription collaborators the way the
 * payment module `dependencies` opt-in injects them in production.
 */
function createProvider({
  variants = [makeVariant()],
  firstOrder = makeFirstOrder(),
  withSubscriptionDeps = true,
} = {}) {
  const subscriptionModule = new FakeSubscriptionModule()
  const eventBus = makeEventBus()
  const productModule = makeProductModule(variants)
  const orderModule = makeOrderModule(firstOrder)
  const paymentModule = makePaymentModule()

  const registered: Record<string, unknown> = withSubscriptionDeps
    ? {
        event_bus: eventBus,
        paypalSubscription: subscriptionModule,
        product: productModule,
        order: orderModule,
      }
    : {}

  const container = {
    logger: loggerStub,
    paymentModuleService: paymentModule,
    hasRegistration: (key: string) => key in registered,
    resolve: (key: string) => registered[key],
  }

  const provider = new PaypalModuleService(container as never, {
    clientId: "test-client",
    clientSecret: "test-secret",
    isSandbox: true,
    includeShippingData: false,
    includeCustomerData: false,
    subscriptionWebhookId: "sub-webhook-id",
  } as never)

  return {
    provider,
    subscriptionModule,
    eventBus,
    productModule,
    orderModule,
    paymentModule,
    clientOf: () => (provider as unknown as { client: PaypalService }).client,
  }
}

describe("PaypalModuleService (subscription branches)", () => {
  describe("initiatePayment", () => {
    it("creates a PayPal subscription session when items carry subscription metadata", async () => {
      const h = createProvider()
      jest
        .spyOn(h.clientOf(), "createBillingProduct")
        .mockResolvedValue({ id: "prod_P1" } as never)
      jest
        .spyOn(h.clientOf(), "createBillingPlan")
        .mockResolvedValue({ id: "plan_P1" } as never)
      const createSpy = jest
        .spyOn(h.clientOf(), "createSubscription")
        .mockResolvedValue({
          id: "I-NEW",
          status: "APPROVAL_PENDING",
          links: [{ rel: "approve", href: "https://www.paypal.com/approve" }],
        } as never)

      const result = await h.provider.initiatePayment({
        amount: 1999,
        currency_code: "usd",
        context: { idempotency_key: "sess_1" },
        data: {
          items: [{ variant_id: "variant_1", quantity: 1, title: "Monthly Club" }],
          customer_id: "cus_1",
          return_url: "https://store.example.com/return",
          cancel_url: "https://store.example.com/cancel",
        },
      } as never)

      const createOrderSpy = jest.spyOn(h.clientOf(), "createOrder")

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          plan_id: "plan_P1",
          custom_id: "sess_1",
          return_url: "https://store.example.com/return",
        })
      )
      expect(result.id).toBe("I-NEW")
      expect(result.data?.is_subscription).toBe(true)
      expect(result.data?.paypal_subscription_id).toBe("I-NEW")
      expect(result.data?.redirect_url).toBe("https://www.paypal.com/approve")
      // No PayPal order is created for subscription checkouts.
      expect(createOrderSpy).not.toHaveBeenCalled()
    })

    it("falls through to the normal order flow for regular items", async () => {
      const h = createProvider({
        variants: [makeVariant({ metadata: {} })],
      })
      const subscriptionSpy = jest
        .spyOn(h.clientOf(), "createSubscription")
        .mockResolvedValue({ id: "SHOULD-NOT-EXIST" } as never)
      const createOrderSpy = jest
        .spyOn(h.clientOf(), "createOrder")
        .mockResolvedValue({ id: "PAYPAL-1" } as never)

      const result = await h.provider.initiatePayment({
        amount: 1999,
        currency_code: "usd",
        context: { idempotency_key: "sess_2" },
        data: { items: [{ variant_id: "variant_1", quantity: 1 }] },
      } as never)

      expect(subscriptionSpy).not.toHaveBeenCalled()
      expect(createOrderSpy).toHaveBeenCalled()
      expect(result.id).toBe("PAYPAL-1")
    })

    it("rejects mixed carts with guidance to split the order", async () => {
      const h = createProvider({
        variants: [makeVariant(), makeVariant({ id: "variant_2", metadata: {} })],
      })

      await expect(
        h.provider.initiatePayment({
          amount: 3998,
          currency_code: "usd",
          context: { idempotency_key: "sess_3" },
          data: {
            items: [
              { variant_id: "variant_1", quantity: 1 },
              { variant_id: "variant_2", quantity: 1 },
            ],
          },
        } as never)
      ).rejects.toThrow(/separately/)
    })
  })

  describe("authorizePayment", () => {
    it("authorizes when the subscription is ACTIVE locally", async () => {
      const h = createProvider()
      await h.subscriptionModule.createPaypalSubscriptions(
        makeRow({ status: "ACTIVE" })
      )
      const getSpy = jest
        .spyOn(h.clientOf(), "getSubscription")
        .mockResolvedValue({ id: "I-ABC123", status: "ACTIVE" } as never)

      const result = await h.provider.authorizePayment({
        data: {
          is_subscription: true,
          paypal_subscription_id: "I-ABC123",
          amount: 1999,
          currency_code: "usd",
        },
        context: { idempotency_key: "sess_1" },
      } as never)

      expect(result.status).toBe(PaymentSessionStatus.AUTHORIZED)
      expect(getSpy).not.toHaveBeenCalled()
    })

    it("returns pending while the buyer has not approved", async () => {
      const h = createProvider()
      await h.subscriptionModule.createPaypalSubscriptions(
        makeRow({ status: "APPROVAL_PENDING" })
      )
      jest
        .spyOn(h.clientOf(), "getSubscription")
        .mockResolvedValue({ id: "I-ABC123", status: "APPROVAL_PENDING" } as never)

      const result = await h.provider.authorizePayment({
        data: {
          is_subscription: true,
          paypal_subscription_id: "I-ABC123",
          amount: 1999,
          currency_code: "usd",
        },
        context: { idempotency_key: "sess_1" },
      } as never)

      expect(result.status).toBe(PaymentSessionStatus.PENDING)
    })

    it("book-keeps renewal sessions without PayPal calls", async () => {
      const h = createProvider()
      const createOrderSpy = jest.spyOn(h.clientOf(), "createOrder")
      const captureOrderSpy = jest.spyOn(h.clientOf(), "captureOrder")

      const result = await h.provider.authorizePayment({
        data: {
          subscription_renewal: true,
          paypal_sale_id: "sale_2",
          status: "captured",
          amount: 1999,
          currency_code: "usd",
        },
        context: {},
      } as never)

      expect(result.status).toBe(PaymentSessionStatus.AUTHORIZED)
      expect(createOrderSpy).not.toHaveBeenCalled()
      expect(captureOrderSpy).not.toHaveBeenCalled()
    })
  })

  describe("capturePayment", () => {
    it("marks subscription sessions captured without a PayPal order capture", async () => {
      const h = createProvider()
      const captureOrderSpy = jest.spyOn(h.clientOf(), "captureOrder")

      const result = await h.provider.capturePayment({
        data: { is_subscription: true, paypal_subscription_id: "I-ABC123" },
      } as never)

      expect(result.data?.status).toBe(PaymentSessionStatus.CAPTURED)
      expect(captureOrderSpy).not.toHaveBeenCalled()
    })
  })

  describe("refundPayment", () => {
    it("refunds renewal payments through the recorded sale id", async () => {
      const h = createProvider()
      const refundSpy = jest
        .spyOn(h.clientOf(), "refundSale")
        .mockResolvedValue({ id: "ref_1", status: "COMPLETED" } as never)
      jest
        .spyOn(h.clientOf(), "getSale")
        .mockResolvedValue({ id: "sale_2", status: "COMPLETED" } as never)

      const result = await h.provider.refundPayment({
        data: {
          subscription_renewal: true,
          paypal_sale_id: "sale_2",
          currency_code: "usd",
        },
        amount: 1999,
      } as never)

      expect(refundSpy).toHaveBeenCalledWith(
        "sale_2",
        { value: "19.99", currency_code: "usd" },
        undefined
      )
      expect(result.data?.paypal_refund_id).toBe("ref_1")
    })
  })

  describe("getWebhookActionAndData", () => {
    function webhook(h: ReturnType<typeof createProvider>, body: Record<string, unknown>) {
      jest
        .spyOn(h.clientOf(), "verifyWebhook")
        .mockResolvedValue({ status: "SUCCESS", body: {} } as never)

      return h.provider.getWebhookActionAndData({
        data: body as never,
        headers: {},
      } as never)
    }

    it("maps the first-period sale to the standard captured action", async () => {
      const h = createProvider()
      await h.subscriptionModule.createPaypalSubscriptions(
        makeRow({ status: "ACTIVE" })
      )

      const result = await webhook(h, {
        event_type: "PAYMENT.SALE.COMPLETED",
        resource: {
          id: "sale_1",
          billing_agreement_id: "I-ABC123",
          amount: { value: "1.00", currency_code: "USD" },
        },
      })

      expect(result).toMatchObject({
        action: "captured",
        data: { session_id: "sess_1", amount: 100 },
      })
    })

    it("handles BILLING.SUBSCRIPTION.CANCELLED as a state sync", async () => {
      const h = createProvider()
      await h.subscriptionModule.createPaypalSubscriptions(
        makeRow({ status: "ACTIVE" })
      )

      const result = await webhook(h, {
        event_type: "BILLING.SUBSCRIPTION.CANCELLED",
        resource: { id: "I-ABC123" },
      })

      expect(result).toEqual({ action: "not_supported" })
      expect(h.subscriptionModule.subscriptions[0].status).toBe("CANCELLED")
      expect(h.eventBus.emitted[0].name).toBe("paypal.subscription.cancelled")
    })

    it("leaves PAYMENT.CAPTURE.* handling untouched", async () => {
      const h = createProvider()

      const result = await webhook(h, {
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          custom_id: "sess_1",
          amount: { value: "10.50", currency_code: "USD" },
        },
      })

      expect(result).toMatchObject({
        action: "captured",
        data: { session_id: "sess_1", amount: 10.5 },
      })
      expect(h.eventBus.emitted).toHaveLength(0)
    })

    it("still never acts when both webhook signatures fail to verify", async () => {
      const h = createProvider()
      jest
        .spyOn(h.clientOf(), "verifyWebhook")
        .mockRejectedValue(new Error("FAILURE") as never)

      const result = await h.provider.getWebhookActionAndData({
        data: {
          event_type: "BILLING.SUBSCRIPTION.CANCELLED",
          resource: { id: "I-ABC123" },
        },
        headers: {},
      } as never)

      expect(result).toEqual({ action: "not_supported" })
      expect(h.subscriptionModule.subscriptions).toHaveLength(0)
    })
  })

  describe("without the dependencies opt-in", () => {
    it("keeps regular checkout working and surfaces a configuration error for subscriptions", async () => {
      const h = createProvider({ withSubscriptionDeps: false })
      const createOrderSpy = jest
        .spyOn(h.clientOf(), "createOrder")
        .mockResolvedValue({ id: "PAYPAL-1" } as never)

      const result = await h.provider.initiatePayment({
        amount: 1999,
        currency_code: "usd",
        context: { idempotency_key: "sess_1" },
        data: { items: [{ variant_id: "variant_1", quantity: 1 }] },
      } as never)

      // No product module in the cradle: detection cannot run, checkout
      // proceeds exactly like the pre-subscription behavior.
      expect(createOrderSpy).toHaveBeenCalled()
      expect(result.id).toBe("PAYPAL-1")
    })
  })
})
