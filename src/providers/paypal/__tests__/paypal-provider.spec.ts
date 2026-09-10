import PaypalModuleService from "../service"
import { PaypalService } from "../paypal-core/paypal-core"
import { PaymentSessionStatus } from "@medusajs/framework/utils"

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

function clientOf(provider: PaypalModuleService): PaypalService {
  return (provider as unknown as { client: PaypalService }).client
}

describe("PaypalModuleService (baseline behavior)", () => {
  describe("validateOptions", () => {
    it("throws when clientId is missing", () => {
      expect(() =>
        PaypalModuleService.validateOptions({
          clientId: "",
          clientSecret: "secret",
          isSandbox: true,
          includeShippingData: false,
          includeCustomerData: false,
        })
      ).toThrow()
    })

    it("accepts a minimal valid options object", () => {
      expect(() =>
        PaypalModuleService.validateOptions({
          clientId: "id",
          clientSecret: "secret",
          isSandbox: true,
          includeShippingData: false,
          includeCustomerData: false,
        })
      ).not.toThrow()
    })
  })

  describe("capturePayment", () => {
    it("returns captured without an API call when already completed", async () => {
      const provider = createProvider()
      const captureSpy = jest
        .spyOn(clientOf(provider), "captureOrder")
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
        .spyOn(clientOf(provider), "captureOrder")
        .mockResolvedValue({ id: "ORDER-1", status: "COMPLETED" } as never)

      const result = await provider.capturePayment({
        data: { id: "ORDER-1", status: "CREATED" },
      } as never)

      expect(result.data?.status).toBe(PaymentSessionStatus.CAPTURED)
      expect(clientOf(provider).captureOrder).toHaveBeenCalledWith("ORDER-1")
    })

    it("throws invalid data when the PayPal order id is missing", async () => {
      const provider = createProvider()

      await expect(
        provider.capturePayment({ data: {} } as never)
      ).rejects.toThrow("Failed to capture PayPal payment")
    })
  })

  describe("initiatePayment", () => {
    it("creates a PayPal order for the major-unit amount and returns its id", async () => {
      const provider = createProvider()
      const createSpy = jest
        .spyOn(clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "PAYPAL-1", status: "CREATED" } as never)

      const result = await provider.initiatePayment({
        amount: 10.5,
        currency_code: "usd",
        context: { idempotency_key: "sess_1" },
        data: {},
      } as never)

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 10.5, currency: "usd" })
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
      jest.spyOn(clientOf(provider), "captureOrder").mockResolvedValue({
        id: "ORDER-1",
        purchaseUnits: [
          { payments: { captures: [{ status: "COMPLETED", id: "CAP-1" }] } },
        ],
      } as never)

      const result = await provider.authorizePayment({
        data: {
          id: "ORDER-1",
          amount: 10.5,
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
        .spyOn(clientOf(provider), "captureOrder")
        .mockRejectedValue(err as never)
      jest
        .spyOn(clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "ORDER-2", status: "CREATED" } as never)

      const result = await provider.authorizePayment({
        data: {
          id: "ORDER-1",
          amount: 10.5,
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

  describe("getPaymentStatus", () => {
    it("maps a completed order to captured", async () => {
      const provider = createProvider()
      jest
        .spyOn(clientOf(provider), "retrieveOrder")
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
        .spyOn(clientOf(provider), "verifyWebhook")
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
        data: { session_id: "sess_1", amount: 10.5 },
      })
    })

    it("returns not_supported for unknown event types", async () => {
      const provider = createProvider()
      jest
        .spyOn(clientOf(provider), "verifyWebhook")
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
        .spyOn(clientOf(provider), "verifyWebhook")
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
        data: { session_id: "sess_1", amount: 10.5 },
      })
    })

    it("never acts on events that fail signature verification", async () => {
      const provider = createProvider()
      jest
        .spyOn(clientOf(provider), "verifyWebhook")
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
        .spyOn(clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "PAYPAL-1", status: "CREATED" } as never)

      await provider.initiatePayment({
        amount: 10.5,
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
        .spyOn(clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "PAYPAL-1", status: "CREATED" } as never)

      await provider.initiatePayment({
        amount: 10.5,
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
      jest.spyOn(clientOf(provider), "captureOrder").mockResolvedValue({
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
          amount: 10.5,
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
      amount: 10.5,
      currency_code: "usd",
    }

    it("skips order creation at initiation for off-session data", async () => {
      const provider = createProvider()
      const createSpy = jest
        .spyOn(clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "SHOULD-NOT-EXIST" } as never)

      const result = await provider.initiatePayment({
        amount: 10.5,
        currency_code: "usd",
        context: { idempotency_key: "sess_renewal" },
        data: { ...mitSessionData },
      } as never)

      expect(createSpy).not.toHaveBeenCalled()
      expect(result.data?.payment_method).toBe("vault-token-1")
      expect(result.data?.amount).toBe(10.5)
      expect(result.data?.currency_code).toBe("usd")
      expect(result.data?.idempotency_key).toBe("sess_renewal")
    })

    it("creates the order against the vault token and captures it", async () => {
      const provider = createProvider()
      const createSpy = jest
        .spyOn(clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "ORDER-V", status: "CREATED" } as never)
      jest.spyOn(clientOf(provider), "captureOrder").mockResolvedValue({
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
        expect.objectContaining({ vaultId: "vault-token-1", amount: 10.5 })
      )
      expect(result.status).toBe(PaymentSessionStatus.AUTHORIZED)
      expect(result.data?.id).toBe("ORDER-V")
      expect(result.data?.status).toBe("COMPLETED")
      expect(result.data?.captured_at).toBeDefined()
    })

    it("throws a decline-carrying error when the capture is declined", async () => {
      const provider = createProvider()
      jest
        .spyOn(clientOf(provider), "createOrder")
        .mockResolvedValue({ id: "ORDER-V", status: "CREATED" } as never)
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
        .spyOn(clientOf(provider), "captureOrder")
        .mockRejectedValue(decline as never)

      await expect(
        provider.authorizePayment({
          data: { ...mitSessionData },
          context: {},
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
        .spyOn(clientOf(provider), "createOrder")
        .mockResolvedValue({
          id: "PAYPAL-1",
          status: "CREATED",
          links: [
            { rel: "self", href: "https://api-m.sandbox.paypal.com/orders" },
            { rel: "approve", href: "https://www.sandbox.paypal.com/approve" },
          ],
        } as never)

      const result = await provider.initiatePayment({
        amount: 10.5,
        currency_code: "usd",
        context: {},
        data: {},
      } as never)

      expect(result.data?.redirect_url).toBe(
        "https://www.sandbox.paypal.com/approve"
      )
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
        .spyOn(clientOf(provider), "listVaultedPaymentMethods")
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
        .spyOn(clientOf(provider), "listVaultedPaymentMethods")
        .mockResolvedValue([] as never)

      const methods = await provider.listPaymentMethods({ context: {} })

      expect(methods).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    })
  })
})
