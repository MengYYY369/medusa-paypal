import PaypalModuleService from "../service"
import { PaypalService } from "../paypal-core/paypal-core"
import { OrdersController } from "@paypal/paypal-server-sdk"
import { MedusaError, PaymentSessionStatus } from "@medusajs/framework/utils"

const loggerStub = {
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}

function createProvider() {
  return new PaypalModuleService(
    { logger: loggerStub as never, paymentModuleService: {} },
    {
      clientId: "test-client",
      clientSecret: "test-secret",
      isSandbox: true,
      includeShippingData: false,
      includeCustomerData: false,
    }
  )
}

/**
 * The provider builds its client lazily from the resolved config, so tests
 * obtain it through the same accessor every call site uses.
 */
async function clientOf(provider: PaypalModuleService): Promise<PaypalService> {
  return (provider as unknown as { getClient(): Promise<PaypalService> }).getClient()
}

describe("PaypalModuleService (baseline behavior)", () => {
  describe("validateOptions", () => {
    const baseOptions = {
      isSandbox: true,
      includeShippingData: false,
      includeCustomerData: false,
    }

    it("boots with a warning when both credentials are missing", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

      expect(() =>
        PaypalModuleService.validateOptions({ ...baseOptions })
      ).not.toThrow()

      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0][0]).toMatch(/unconfigured/)
      expect(warnSpy.mock.calls[0][0]).toMatch(/admin PayPal settings page/)

      warnSpy.mockRestore()
    })

    it("treats empty and whitespace-only credentials as missing too", () => {
      const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {})

      expect(() =>
        PaypalModuleService.validateOptions({
          ...baseOptions,
          clientId: "   ",
          clientSecret: "",
        })
      ).not.toThrow()

      expect(warnSpy).toHaveBeenCalledTimes(1)

      warnSpy.mockRestore()
    })

    it("throws when exactly one credential is missing", () => {
      expect(() =>
        PaypalModuleService.validateOptions({
          ...baseOptions,
          clientId: "",
          clientSecret: "secret",
        })
      ).toThrow(/clientId is missing/)

      expect(() =>
        PaypalModuleService.validateOptions({
          ...baseOptions,
          clientId: "id",
          clientSecret: "   ",
        })
      ).toThrow(/clientSecret is missing/)
    })

    it("accepts a minimal valid options object", () => {
      expect(() =>
        PaypalModuleService.validateOptions({
          clientId: "id",
          clientSecret: "secret",
          ...baseOptions,
        })
      ).not.toThrow()
    })
  })

  describe("runtime configuration guard", () => {
    it("refuses PayPal calls with a configuration error when unconfigured", async () => {
      const provider = new PaypalModuleService(
        { logger: loggerStub as never, paymentModuleService: {} },
        {
          isSandbox: true,
          includeShippingData: false,
          includeCustomerData: false,
        } as never
      )

      await expect(
        provider.initiatePayment({
          amount: 1050,
          currency_code: "usd",
          context: {},
          data: {},
        } as never)
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringContaining("PayPal is not configured"),
      })
    })
  })

  describe("deletePayment", () => {
    it("cancels the billing subscription of an abandoned native session", async () => {
      const provider = createProvider()
      const cancelSpy = jest
        .spyOn(await clientOf(provider), "subscriptionAction")
        .mockResolvedValue(undefined as never)

      const result = await provider.deletePayment({
        data: { is_subscription: true, paypal_subscription_id: "I-ABANDONED" },
      } as never)

      expect(cancelSpy).toHaveBeenCalledWith(
        "I-ABANDONED",
        "cancel",
        "Abandoned checkout"
      )
      expect(result.data).toMatchObject({
        subscription_id: "I-ABANDONED",
        status: PaymentSessionStatus.CANCELED,
      })
    })

    it("falls back to the session id when only the subscription flag is set", async () => {
      const provider = createProvider()
      const cancelSpy = jest
        .spyOn(await clientOf(provider), "subscriptionAction")
        .mockResolvedValue(undefined as never)

      await provider.deletePayment({
        data: { is_subscription: true, id: "I-FROM-ID" },
      } as never)

      expect(cancelSpy).toHaveBeenCalledWith(
        "I-FROM-ID",
        "cancel",
        "Abandoned checkout"
      )
    })

    it("swallows an already-gone subscription and still reports cancelled", async () => {
      const provider = createProvider()
      loggerStub.warn.mockClear()
      jest
        .spyOn(await clientOf(provider), "subscriptionAction")
        .mockRejectedValue(
          Object.assign(new Error("The requested resource was not found."), {
            statusCode: 404,
            body: JSON.stringify({ name: "INVALID_RESOURCE_ID" }),
          })
        )

      const result = await provider.deletePayment({
        data: { is_subscription: true, paypal_subscription_id: "I-GONE" },
      } as never)

      expect(result.data).toMatchObject({
        subscription_id: "I-GONE",
        status: PaymentSessionStatus.CANCELED,
      })
      expect(loggerStub.warn).toHaveBeenCalledWith(
        expect.stringContaining("I-GONE")
      )
    })

    it("does not let a PayPal outage block the session delete", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "subscriptionAction")
        .mockRejectedValue(new Error("socket hang up"))

      await expect(
        provider.deletePayment({
          data: { is_subscription: true, paypal_subscription_id: "I-NET" },
        } as never)
      ).resolves.toMatchObject({
        data: { status: PaymentSessionStatus.CANCELED },
      })
    })

    it("reports cancelled without a PayPal call when no order was ever created", async () => {
      const provider = createProvider()
      const cancelSpy = jest
        .spyOn(await clientOf(provider), "subscriptionAction")
        .mockRejectedValue(new Error("must not be called"))

      const result = await provider.deletePayment({ data: {} } as never)

      expect(cancelSpy).not.toHaveBeenCalled()
      expect(result.data).toMatchObject({
        status: PaymentSessionStatus.CANCELED,
      })
      expect(result.data).not.toHaveProperty("order_id")
    })

    it("reports the order cancelled for a plain order session", async () => {
      const provider = createProvider()

      const result = await provider.deletePayment({
        data: { id: "ORDER-1" },
      } as never)

      expect(result.data).toMatchObject({
        order_id: "ORDER-1",
        status: PaymentSessionStatus.CANCELED,
      })
    })

    it("still requires session data", async () => {
      const provider = createProvider()

      await expect(provider.deletePayment({} as never)).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringContaining("Payment data is required"),
      })
    })
  })

  describe("capturePayment", () => {
    it("returns captured without an API call when already completed", async () => {
      const provider = createProvider()
      const captureSpy = jest
        .spyOn(await clientOf(provider), "captureOrder")
        .mockResolvedValue({ id: "ORDER-1" } as never)

      const result = await provider.capturePayment({
        data: { id: "ORDER-1", status: "COMPLETED" },
      } as never)

      expect(result.data?.status).toBe(PaymentSessionStatus.CAPTURED)
      expect(captureSpy).not.toHaveBeenCalled()
    })

    it("captures the PayPal order and returns captured", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "captureOrder")
        .mockResolvedValue({ id: "ORDER-1", status: "COMPLETED" } as never)

      const result = await provider.capturePayment({
        data: { id: "ORDER-1", status: "CREATED" },
      } as never)

      expect(result.data?.status).toBe(PaymentSessionStatus.CAPTURED)
      expect((await clientOf(provider)).captureOrder).toHaveBeenCalledWith("ORDER-1")
    })

    it("throws invalid data when the PayPal order id is missing", async () => {
      const provider = createProvider()

      await expect(
        provider.capturePayment({ data: {} } as never)
      ).rejects.toThrow("PayPal order ID is required to capture payment")
    })
  })

  describe("initiatePayment", () => {
    it("creates a PayPal order for the major-unit amount and returns its id", async () => {
      const provider = createProvider()
      const createSpy = jest
        .spyOn(await clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "PAYPAL-1", status: "CREATED" } as never)

      const result = await provider.initiatePayment({
        amount: 1050,
        currency_code: "usd",
        context: { idempotency_key: "sess_1" },
        data: {},
      } as never)

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 1050, currency: "usd" })
      )
      expect(result.id).toBe("PAYPAL-1")
      expect(result.data?.idempotency_key).toBe("sess_1")
    })

    it("requires amount and currency code", async () => {
      const provider = createProvider()

      await expect(
        provider.initiatePayment({ data: {} } as never)
      ).rejects.toThrow("Amount and currency code are required")
    })
  })

  describe("authorizePayment", () => {
    it("authorizes a captured order", async () => {
      const provider = createProvider()
      jest.spyOn(await clientOf(provider), "captureOrder").mockResolvedValue({
        id: "ORDER-1",
        purchaseUnits: [
          { payments: { captures: [{ status: "COMPLETED", id: "CAP-1" }] } },
        ],
      } as never)

      const result = await provider.authorizePayment({
        data: {
          id: "ORDER-1",
          amount: 1050,
          currency_code: "usd",
          status: "APPROVED",
        },
        context: {},
      } as never)

      expect(result.status).toBe(PaymentSessionStatus.AUTHORIZED)
    })

    it("returns pending with a structured error and a fresh order on decline", async () => {
      const provider = createProvider()
      const err = Object.assign(new Error("declined"), {
        body: JSON.stringify({
          purchase_units: [
            {
              payments: {
                captures: [{ status: "DECLINED", id: "CAP-1" }],
              },
            },
          ],
        }),
      })
      jest
        .spyOn(await clientOf(provider), "captureOrder")
        .mockRejectedValue(err as never)
      jest
        .spyOn(await clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "ORDER-2", status: "CREATED" } as never)

      const result = await provider.authorizePayment({
        data: {
          id: "ORDER-1",
          amount: 1050,
          currency_code: "usd",
          status: "APPROVED",
        },
        context: {},
      } as never)

      expect(result.status).toBe(PaymentSessionStatus.PENDING)
      expect(result.data?.id).toBe("ORDER-2")
      expect(result.data?.error).toBeDefined()
    })
  })

  /**
   * Every call site that forwards `items` funnels through the single mapping in
   * `PaypalService.createOrder`, so one guard covers all three: session
   * initiation and `authorizePayment`'s two order-rebuild paths (capture
   * rejected, capture declined). These tests run the real mapping - only the
   * SDK call is stubbed - and pin that a bad item is rejected with the field
   * named, rather than as a `TypeError` or a literal `"NaN"` amount that PayPal
   * answers with an opaque 400.
   */
  describe("item contract", () => {
    let sdkCreateOrder: jest.SpyInstance

    beforeEach(() => {
      sdkCreateOrder = jest
        .spyOn(OrdersController.prototype, "createOrder")
        .mockResolvedValue({ result: { id: "ORDER-NEW" } } as never)
    })

    afterEach(() => {
      sdkCreateOrder.mockRestore()
    })

    it("rejects an item without a unit_price when initiating the session", async () => {
      const provider = createProvider()

      await expect(
        provider.initiatePayment({
          amount: 1050,
          currency_code: "usd",
          context: { idempotency_key: "sess_1" },
          data: { items: [{ title: "Pro Plan", quantity: 1 }] },
        } as never)
      ).rejects.toThrow('Invalid item "Pro Plan": unit_price must be a number')

      expect(sdkCreateOrder).not.toHaveBeenCalled()
    })

    it("rejects an item without a title on the rebuild after a rejected capture", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "captureOrder")
        .mockRejectedValue(
          Object.assign(new Error("capture failed"), { body: "{}" }) as never
        )

      await expect(
        provider.authorizePayment({
          data: {
            id: "ORDER-1",
            amount: 1050,
            currency_code: "usd",
            status: "APPROVED",
            items: [{ unit_price: 9.99, quantity: 1 }],
          },
          context: {},
        } as never)
      ).rejects.toThrow("Invalid item at index 0: title is required")

      expect(sdkCreateOrder).not.toHaveBeenCalled()
    })

    it("rejects a fractional quantity on the rebuild after a declined capture", async () => {
      const provider = createProvider()
      jest.spyOn(await clientOf(provider), "captureOrder").mockResolvedValue({
        id: "ORDER-1",
        purchaseUnits: [
          {
            payments: {
              captures: [
                {
                  status: "DECLINED",
                  id: "CAP-1",
                  amount: { value: "10.50", currencyCode: "USD" },
                },
              ],
            },
          },
        ],
      } as never)

      await expect(
        provider.authorizePayment({
          data: {
            id: "ORDER-1",
            amount: 1050,
            currency_code: "usd",
            status: "APPROVED",
            items: [{ title: "Pro Plan", unit_price: 9.99, quantity: 1.5 }],
          },
          context: {},
        } as never)
      ).rejects.toThrow("quantity must be a positive whole number")

      expect(sdkCreateOrder).not.toHaveBeenCalled()
    })
  })

  describe("getPaymentStatus", () => {
    it("maps a completed order to captured", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "retrieveOrder")
        .mockResolvedValue({ id: "ORDER-1", status: "COMPLETED" } as never)

      const result = await provider.getPaymentStatus({
        data: { id: "ORDER-1" },
      } as never)

      expect(result.status).toBe(PaymentSessionStatus.CAPTURED)
    })
  })

  describe("getWebhookActionAndData", () => {
    it("maps PAYMENT.CAPTURE.COMPLETED to captured", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "verifyWebhook")
        .mockResolvedValue({ status: "SUCCESS", body: {} })

      const result = await provider.getWebhookActionAndData({
        data: {
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          resource: {
            custom_id: "sess_1",
            amount: { value: "10.50", currency_code: "USD" },
          },
        },
        headers: {},
      } as never)

      expect(result).toMatchObject({
        action: "captured",
        // amount comes from the PayPal webhook payload (major units).
        data: { session_id: "sess_1", amount: 10.5 },
      })
    })

    it("returns not_supported for unknown event types", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "verifyWebhook")
        .mockResolvedValue({ status: "SUCCESS", body: {} })

      const result = await provider.getWebhookActionAndData({
        data: {
          event_type: "VAULT.PAYMENT-TOKEN.DELETED",
          resource: { id: "vault-token-1" },
        },
        headers: {},
      } as never)

      expect(result).toEqual({ action: "not_supported" })
    })

    it("maps PAYMENT.CAPTURE.DECLINED to a failed action", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "verifyWebhook")
        .mockResolvedValue({ status: "SUCCESS", body: {} })

      const result = await provider.getWebhookActionAndData({
        data: {
          event_type: "PAYMENT.CAPTURE.DECLINED",
          resource: {
            custom_id: "sess_1",
            amount: { value: "10.50", currency_code: "USD" },
          },
        },
        headers: {},
      } as never)

      expect(result).toMatchObject({
        action: "failed",
        // amount comes from the PayPal webhook payload (major units).
        data: { session_id: "sess_1", amount: 10.5 },
      })
    })

    it("never acts on events that fail signature verification", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "verifyWebhook")
        .mockRejectedValue(new Error("verification_status FAILURE"))

      const result = await provider.getWebhookActionAndData({
        data: {
          event_type: "PAYMENT.CAPTURE.COMPLETED",
          resource: {
            custom_id: "sess_1",
            amount: { value: "10.50", currency_code: "USD" },
          },
        },
        headers: {},
      } as never)

      expect(result).toEqual({ action: "not_supported" })
    })
  })
})

describe("PaypalModuleService (vault save + off-session charges)", () => {
  describe("checkout vault save (CIT)", () => {
    it("passes the merchant customer id to the order when the session opts into vaulting", async () => {
      const provider = createProvider()
      const createSpy = jest
        .spyOn(await clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "PAYPAL-1", status: "CREATED" } as never)

      await provider.initiatePayment({
        amount: 1050,
        currency_code: "usd",
        context: { idempotency_key: "sess_1" },
        data: { customer_id: "cus_1" },
      } as never)

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ vaultCustomerId: "cus_1" })
      )
    })

    it("does not opt into vaulting without a customer id", async () => {
      const provider = createProvider()
      const createSpy = jest
        .spyOn(await clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "PAYPAL-1", status: "CREATED" } as never)

      await provider.initiatePayment({
        amount: 1050,
        currency_code: "usd",
        context: {},
        data: {},
      } as never)

      const call = createSpy.mock.calls[0][0] as unknown as Record<
        string,
        unknown
      >
      expect(call.vaultCustomerId).toBeUndefined()
      expect(call.vaultId).toBeUndefined()
    })

    it("writes the vault token id into session data after a vaulted capture", async () => {
      const provider = createProvider()
      jest.spyOn(await clientOf(provider), "captureOrder").mockResolvedValue({
        id: "ORDER-1",
        status: "COMPLETED",
        purchaseUnits: [
          { payments: { captures: [{ status: "COMPLETED", id: "CAP-1" }] } },
        ],
        paymentSource: {
          paypal: {
            attributes: { vault: { id: "vault-token-9", status: "VAULTED" } },
          },
        },
      } as never)

      const result = await provider.authorizePayment({
        data: {
          id: "ORDER-1",
          amount: 1050,
          currency_code: "usd",
          status: "APPROVED",
        },
        context: {},
      } as never)

      expect(result.status).toBe(PaymentSessionStatus.AUTHORIZED)
      expect(result.data?.payment_method).toBe("vault-token-9")
      expect(result.data?.vault_id).toBe("vault-token-9")
      expect(result.data?.vault_status).toBe("VAULTED")
    })
  })

  describe("off-session renewal charges (MIT)", () => {
    const mitSessionData = {
      off_session: true,
      payment_method: "vault-token-1",
      amount: 1050,
      currency_code: "usd",
    }

    it("skips order creation at initiation for off-session data", async () => {
      const provider = createProvider()
      const createSpy = jest
        .spyOn(await clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "SHOULD-NOT-EXIST" } as never)

      const result = await provider.initiatePayment({
        amount: 1050,
        currency_code: "usd",
        context: { idempotency_key: "sess_renewal" },
        data: { ...mitSessionData },
      } as never)

      expect(createSpy).not.toHaveBeenCalled()
      expect(result.data?.payment_method).toBe("vault-token-1")
      expect(result.data?.amount).toBe(1050)
      expect(result.data?.currency_code).toBe("usd")
      expect(result.data?.idempotency_key).toBe("sess_renewal")
    })

    it("mints the order against the vault token and captures via capturePayment", async () => {
      const provider = createProvider()
      const createSpy = jest
        .spyOn(await clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "ORDER-V", status: "CREATED" } as never)
      const captureSpy = jest
        .spyOn(await clientOf(provider), "captureOrder")
        .mockResolvedValue({
          id: "ORDER-V",
          status: "COMPLETED",
          purchaseUnits: [
            { payments: { captures: [{ status: "COMPLETED", id: "CAP-V" }] } },
          ],
        } as never)

      const result = await provider.authorizePayment({
        data: { ...mitSessionData },
        context: { idempotency_key: "sess_renewal" },
      } as never)

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ vaultId: "vault-token-1", amount: 1050 })
      )
      // Authorize only mints the order; the standard capturePayment step
      // performs the single capture (authorize-capturing would make the
      // renewal engine's follow-up capturePayment hit ORDER_ALREADY_CAPTURED).
      expect(captureSpy).not.toHaveBeenCalled()
      expect(result.status).toBe(PaymentSessionStatus.AUTHORIZED)
      expect(result.data?.id).toBe("ORDER-V")
      expect(result.data?.status).toBe("CREATED")

      const captured = await provider.capturePayment({
        data: result.data,
      } as never)

      expect(captureSpy).toHaveBeenCalledWith("ORDER-V")
      expect(captured.data?.status).toBe(PaymentSessionStatus.CAPTURED)
    })

    it("throws a decline-carrying error when the capture is declined", async () => {
      const provider = createProvider()
      const decline = Object.assign(new Error("capture failed"), {
        body: JSON.stringify({
          name: "UNPROCESSABLE_ENTITY",
          details: [
            {
              issue: "INSTRUMENT_DECLINED",
              description: "The instrument presented was declined",
            },
          ],
        }),
      })
      jest
        .spyOn(await clientOf(provider), "captureOrder")
        .mockRejectedValue(decline as never)

      await expect(
        provider.capturePayment({
          data: { id: "ORDER-V", off_session: true },
        } as never)
      ).rejects.toThrow(/INSTRUMENT_DECLINED/)
    })

    it("rejects off-session data without amount or currency", async () => {
      const provider = createProvider()

      await expect(
        provider.authorizePayment({
          data: { off_session: true, payment_method: "vault-token-1" },
          context: {},
        } as never)
      ).rejects.toThrow(
        "requires amount, currency code and a vaulted payment method reference"
      )
    })
  })

  describe("redirect and saved methods", () => {
    it("exposes the PayPal approval link as redirect_url", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "createOrder")
        .mockResolvedValue({
          id: "PAYPAL-1",
          status: "CREATED",
          links: [
            { rel: "self", href: "https://api-m.sandbox.paypal.com/orders" },
            { rel: "approve", href: "https://www.sandbox.paypal.com/approve" },
          ],
        } as never)

      const result = await provider.initiatePayment({
        amount: 1050,
        currency_code: "usd",
        context: {},
        data: {},
      } as never)

      expect(result.data?.redirect_url).toBe(
        "https://www.sandbox.paypal.com/approve"
      )
    })

    it("falls back to the payer-action link for a vaulted order", async () => {
      const provider = createProvider()
      const links = [
        {
          rel: "self",
          href: "https://api-m.sandbox.paypal.com/orders/PAYPAL-1",
        },
        {
          rel: "payer-action",
          href: "https://www.sandbox.paypal.com/payer-action?token=PAYPAL-1",
        },
      ]
      jest
        .spyOn(await clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "PAYPAL-1", status: "CREATED", links } as never)

      const result = await provider.initiatePayment({
        amount: 1050,
        currency_code: "usd",
        context: {},
        data: { customer_id: "cus_1" },
      } as never)

      expect(result.data?.redirect_url).toBe(
        "https://www.sandbox.paypal.com/payer-action?token=PAYPAL-1"
      )
      // The raw links ride along in the session data (the `...order` spread),
      // so a storefront can read a relation the plugin does not model.
      expect(result.data?.links).toEqual(links)
    })

    it("leaves redirect_url unset when PayPal offers neither approval link", async () => {
      const provider = createProvider()
      jest.spyOn(await clientOf(provider), "createOrder").mockResolvedValue({
        id: "PAYPAL-1",
        status: "CREATED",
        links: [
          {
            rel: "self",
            href: "https://api-m.sandbox.paypal.com/orders/PAYPAL-1",
          },
        ],
      } as never)

      const result = await provider.initiatePayment({
        amount: 1050,
        currency_code: "usd",
        context: {},
        data: {},
      } as never)

      expect(result.data?.redirect_url).toBeUndefined()
    })

    it("creates an account holder keyed to the Medusa customer id", async () => {
      const provider = createProvider()

      const holder = await provider.createAccountHolder({
        context: { customer: { id: "cus_1", email: "buyer@example.com" } },
      })

      expect(holder.id).toBe("cus_1")
      expect(holder.data).toEqual({ email: "buyer@example.com" })
    })

    it("requires a customer when creating an account holder", async () => {
      const provider = createProvider()

      await expect(
        provider.createAccountHolder({ context: {} })
      ).rejects.toThrow("requires a customer")
    })

    it("lists vaulted wallets as payment methods for the account holder", async () => {
      const provider = createProvider()
      const listSpy = jest
        .spyOn(await clientOf(provider), "listVaultedPaymentMethods")
        .mockResolvedValue([
          {
            id: "vault-token-1",
            paymentSource: {
              paypal: { emailAddress: "buyer@example.com" },
            },
          },
          { id: "vault-token-card-only", paymentSource: {} },
        ] as never)

      const methods = await provider.listPaymentMethods({
        context: { account_holder: { external_id: "cus_1" } },
      })

      expect(listSpy).toHaveBeenCalledWith("cus_1")
      expect(methods).toHaveLength(1)
      expect(methods[0]).toEqual({
        id: "vault-token-1",
        data: { type: "paypal", email: "buyer@example.com" },
      })
    })

    it("returns no methods without an account holder", async () => {
      const provider = createProvider()
      const listSpy = jest
        .spyOn(await clientOf(provider), "listVaultedPaymentMethods")
        .mockResolvedValue([] as never)

      const methods = await provider.listPaymentMethods({ context: {} })

      expect(methods).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    })
  })

  describe("deletePaymentMethod", () => {
    const context = { account_holder: { external_id: "cus_1" } }

    it("deletes a token that belongs to the account holder", async () => {
      const provider = createProvider()
      const listSpy = jest
        .spyOn(await clientOf(provider), "listVaultedPaymentMethods")
        .mockResolvedValue([{ id: "vault-token-1" }] as never)
      const deleteSpy = jest
        .spyOn(await clientOf(provider), "deleteVaultedPaymentMethod")
        .mockResolvedValue(undefined as never)

      await expect(
        provider.deletePaymentMethod({
          context,
          data: { id: "vault-token-1" },
        } as never)
      ).resolves.toEqual({})

      expect(listSpy).toHaveBeenCalledWith("cus_1")
      expect(deleteSpy).toHaveBeenCalledWith("vault-token-1")
    })

    it("refuses a token that is not in the account holder's vault", async () => {
      const provider = createProvider()
      jest
        .spyOn(await clientOf(provider), "listVaultedPaymentMethods")
        .mockResolvedValue([{ id: "vault-token-1" }] as never)
      const deleteSpy = jest.spyOn(
        await clientOf(provider),
        "deleteVaultedPaymentMethod"
      )

      await expect(
        provider.deletePaymentMethod({
          context,
          data: { id: "someone-elses-token" },
        } as never)
      ).rejects.toMatchObject({
        type: MedusaError.Types.NOT_FOUND,
        // The refusal names no id: the token id is a secret.
        message: expect.not.stringContaining("someone-elses-token"),
      })

      expect(deleteSpy).not.toHaveBeenCalled()
    })

    it("requires an account holder", async () => {
      const provider = createProvider()
      const listSpy = jest.spyOn(
        await clientOf(provider),
        "listVaultedPaymentMethods"
      )

      await expect(
        provider.deletePaymentMethod({ context: {}, data: { id: "vault-token-1" } })
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringContaining("account holder"),
      })

      expect(listSpy).not.toHaveBeenCalled()
    })

    it("requires a payment method id", async () => {
      const provider = createProvider()

      await expect(
        provider.deletePaymentMethod({ context, data: {} } as never)
      ).rejects.toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringContaining("payment method id"),
      })
    })
  })
})

describe("PaypalModuleService (resolved configuration)", () => {
  /**
   * A container whose paypalSubscription module resolves through the real
   * resolver contract: the provider must read credentials, environment,
   * webhook ids and engine options from it, not from the bootstrap options.
   */
  function createProviderWithResolver() {
    let version = 1
    let resolvedConfig: Record<string, unknown> = {
      clientId: "db-client",
      clientSecret: "db-secret",
      isSandbox: true,
      webhookId: "webhook-primary",
      subscriptionWebhookId: "webhook-subscription",
      includeShippingData: false,
      includeCustomerData: false,
      autoBillOutstanding: true,
      paymentFailureThreshold: 3,
    }

    const resolver = {
      getResolvedPaypalConfig: jest.fn(async () => ({
        config: resolvedConfig,
        version,
        sources: {},
        meta: {},
      })),
    }

    const container = {
      logger: loggerStub,
      paymentModuleService: {},
      hasRegistration: (key: string) => key === "paypalSubscription",
      resolve: (key: string) =>
        key === "paypalSubscription" ? resolver : undefined,
    }

    const provider = new PaypalModuleService(container as never, {
      clientId: "bootstrap-client",
      clientSecret: "bootstrap-secret",
      isSandbox: false,
      includeShippingData: false,
      includeCustomerData: false,
    } as never)

    return {
      provider,
      bump: (patch: Record<string, unknown>) => {
        version += 1
        resolvedConfig = { ...resolvedConfig, ...patch }
      },
    }
  }

  it("builds the client from the resolved config and reuses it while the version is stable", async () => {
    const h = createProviderWithResolver()

    const client = await clientOf(h.provider)

    // The bootstrap options said live; the resolved config wins.
    expect(client.environment).toBe("sandbox")
    expect(await clientOf(h.provider)).toBe(client)
  })

  it("rebuilds the client and the engine when the resolved config changes", async () => {
    const h = createProviderWithResolver()

    const client = await clientOf(h.provider)
    const engine = await (h.provider as any).getSubscriptionEngine()

    expect(await (h.provider as any).getSubscriptionEngine()).toBe(engine)

    h.bump({
      isSandbox: false,
      autoBillOutstanding: false,
      paymentFailureThreshold: 7,
    })

    const rebuiltClient = await clientOf(h.provider)
    const rebuiltEngine = await (h.provider as any).getSubscriptionEngine()

    expect(rebuiltClient).not.toBe(client)
    expect(rebuiltClient.environment).toBe("live")
    expect(rebuiltEngine).not.toBe(engine)
    expect((rebuiltEngine as any).deps.options).toEqual({
      autoBillOutstanding: false,
      paymentFailureThreshold: 7,
    })
  })

  it("verifies webhooks with the resolved subscription webhook id fallback", async () => {
    const h = createProviderWithResolver()
    const verifySpy = jest
      .spyOn(await clientOf(h.provider), "verifyWebhook")
      .mockRejectedValueOnce(new Error("primary id rejected"))
      .mockResolvedValueOnce({ status: "SUCCESS", body: {} } as never)

    const result = await h.provider.getWebhookActionAndData({
      data: {
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          custom_id: "sess_1",
          amount: { value: "10.50", currency_code: "USD" },
        },
      },
      headers: {},
    } as never)

    expect(result).toMatchObject({ action: "captured" })
    expect(verifySpy).toHaveBeenCalledTimes(2)
    expect(verifySpy.mock.calls[1][0]).toMatchObject({
      webhookId: "webhook-subscription",
    })
  })

  it("verifies with the subscription webhook id edited after boot", async () => {
    const h = createProviderWithResolver()

    h.bump({ subscriptionWebhookId: "webhook-subscription-v2" })

    const verifySpy = jest
      .spyOn(await clientOf(h.provider), "verifyWebhook")
      .mockRejectedValueOnce(new Error("primary id rejected"))
      .mockResolvedValueOnce({ status: "SUCCESS", body: {} } as never)

    const result = await h.provider.getWebhookActionAndData({
      data: {
        event_type: "PAYMENT.CAPTURE.COMPLETED",
        resource: {
          custom_id: "sess_1",
          amount: { value: "10.50", currency_code: "USD" },
        },
      },
      headers: {},
    } as never)

    expect(result).toMatchObject({ action: "captured" })
    expect(verifySpy.mock.calls[1][0]).toMatchObject({
      webhookId: "webhook-subscription-v2",
    })
  })
})
