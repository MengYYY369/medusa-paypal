import { MedusaError } from "@medusajs/framework/utils";
import { OrdersController } from "@paypal/paypal-server-sdk";
import { derivePaypalCustomerId, PaypalService } from "../paypal-core";

/**
 * Vault v3 setup-token / payment-token contract locks over a mocked
 * VaultController. The request body is the whole contract here: PayPal
 * rejects the vault flow (422) when the merchant customer id sits inside
 * `paymentSource`, when the vault instruction is missing, or when the
 * return/cancel URLs are not absolute - none of which a mocked controller
 * would notice on its own.
 */

const RETURN_URL = "https://shop.example.com/paypal/return";
const CANCEL_URL = "https://shop.example.com/paypal/cancel";

const APPROVE_URL = "https://www.sandbox.paypal.com/checkoutnow?token=SETUP-1";
const PAYER_ACTION_URL =
  "https://www.sandbox.paypal.com/payer-action?token=SETUP-1";

type VaultSetupTokenBody = {
  customer?: { id?: string; merchantCustomerId?: string };
  paymentSource: {
    paypal?: {
      usageType?: string;
      permitMultiplePaymentTokens?: boolean;
      experienceContext?: {
        returnUrl?: string;
        cancelUrl?: string;
        vaultInstruction?: string;
      };
    };
  };
};

type VaultPaymentTokenBody = {
  paymentSource: {
    token?: { id?: string; type?: string };
  };
};

type MockVaultController = {
  createSetupToken: jest.Mock<Promise<unknown>, [{ body: VaultSetupTokenBody }]>;
  getSetupToken: jest.Mock<Promise<unknown>, [string]>;
  createPaymentToken: jest.Mock<
    Promise<unknown>,
    [{ body: VaultPaymentTokenBody }]
  >;
  listCustomerPaymentTokens: jest.Mock<
    Promise<unknown>,
    [{ customerId: string }]
  >;
};

function makeMockVaultController(): MockVaultController {
  return {
    createSetupToken: jest.fn(),
    getSetupToken: jest.fn(),
    createPaymentToken: jest.fn(),
    listCustomerPaymentTokens: jest.fn(),
  };
}

function makeClient(mock: MockVaultController): PaypalService {
  const client = new PaypalService({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    isSandbox: true,
    includeShippingData: false,
    includeCustomerData: false,
  });

  (
    client as unknown as { vaultController: MockVaultController }
  ).vaultController = mock;

  return client;
}

/** Resolves with the rejection so its MedusaError type can be asserted. */
async function captureRejection(promise: Promise<unknown>): Promise<MedusaError> {
  try {
    await promise;
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(MedusaError);

    return thrown as MedusaError;
  }

  throw new Error("Expected the call to reject");
}

/**
 * UNEXPECTED_STATE must stay outside the six types the subscription engine's
 * classifier preserves, otherwise an upstream vault fault would surface to
 * the caller as a fabricated 400 customer refusal instead of a 500.
 */
function expectNotClassifierPreserved(type: string): void {
  expect([
    MedusaError.Types.NOT_FOUND,
    MedusaError.Types.INVALID_DATA,
    MedusaError.Types.NOT_ALLOWED,
    MedusaError.Types.CONFLICT,
    MedusaError.Types.DUPLICATE_ERROR,
    MedusaError.Types.PAYMENT_AUTHORIZATION_ERROR,
  ]).not.toContain(type);
}

const upstreamFailure = {
  statusCode: 422,
  result: {
    name: "UNPROCESSABLE_ENTITY",
    details: [
      {
        issue: "SETUP_TOKEN_ID_NOT_FOUND",
        description: "Setup token SETUP-SECRET-123 is invalid",
      },
    ],
  },
};

describe("derivePaypalCustomerId", () => {
  /**
   * PayPal's `customer.id` and the list parameter are both capped at 22
   * characters over `[0-9a-zA-Z_-]`; Medusa customer ids are 30, so a value
   * that breaks either limit would turn the listing into a 400.
   */
  it("produces exactly 22 characters of PayPal's allowed alphabet", () => {
    const derived = derivePaypalCustomerId("cus_01M2RJY2ESYR7X87A000SV0TCX");

    expect(derived).toMatch(/^[0-9a-zA-Z_-]{22}$/);
  });

  it("matches the sandbox-verified value for a known Medusa customer id", () => {
    // Golden value from the 0.9.0 sandbox verification. The derived id is a
    // permanent external key, so a change to the digest or to input handling
    // must fail loudly here rather than silently orphan already-minted tokens.
    expect(derivePaypalCustomerId("cus_01M2RJY2ESYR7X87A000SV0TCX")).toBe(
      "RiY_lqIlWvqOZW-UK-x8Xm",
    );
  });

  it("is deterministic for the same merchant customer id", () => {
    expect(derivePaypalCustomerId("cus_123")).toBe(
      derivePaypalCustomerId("cus_123"),
    );
  });

  it("maps distinct merchant customer ids to distinct derived ids", () => {
    expect(derivePaypalCustomerId("cus_123")).not.toBe(
      derivePaypalCustomerId("cus_124"),
    );
  });
});

describe("PaypalService.createVaultSetupToken", () => {
  it("sends the wallet vault body with the derived customer id only", async () => {
    const mock = makeMockVaultController();
    mock.createSetupToken.mockResolvedValue({
      result: {
        id: "SETUP-1",
        status: "CREATED",
        links: [{ rel: "approve", href: APPROVE_URL, method: "GET" }],
      },
    });
    const client = makeClient(mock);

    const start = await client.createVaultSetupToken({
      customer_id: "cus_123",
      return_url: RETURN_URL,
      cancel_url: CANCEL_URL,
    });

    expect(mock.createSetupToken).toHaveBeenCalledTimes(1);

    const [{ body }] = mock.createSetupToken.mock.calls[0];

    expect(body.customer).toEqual({ id: derivePaypalCustomerId("cus_123") });
    // The merchant id is never sent: PayPal freezes a customer record's
    // `customer.id` at the first `merchant_customer_id` association and would
    // ignore the derived id afterwards.
    expect(body.customer).not.toHaveProperty("merchantCustomerId");
    expect(body.paymentSource.paypal?.usageType).toBe("MERCHANT");
    expect(body.paymentSource.paypal?.experienceContext).toEqual({
      returnUrl: RETURN_URL,
      cancelUrl: CANCEL_URL,
      vaultInstruction: "ON_PAYER_APPROVAL",
    });
    // The wallet request object has no customer member: the id is top-level.
    expect(body.paymentSource.paypal).not.toHaveProperty("customer");
    // Per-customer tokens: without the flag PayPal reuses the payer's
    // existing token, which carries a previously vaulted customer's id.
    expect(
      body.paymentSource.paypal?.permitMultiplePaymentTokens,
    ).toBe(true);

    expect(start).toEqual({
      setup_token_id: "SETUP-1",
      approve_url: APPROVE_URL,
    });
  });

  it("prefers the approve link when both approve and payer-action are present", async () => {
    const mock = makeMockVaultController();
    mock.createSetupToken.mockResolvedValue({
      result: {
        id: "SETUP-1",
        links: [
          { rel: "self", href: "https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/SETUP-1" },
          { rel: "approve", href: APPROVE_URL },
          { rel: "payer-action", href: PAYER_ACTION_URL },
        ],
      },
    });
    const client = makeClient(mock);

    await expect(
      client.createVaultSetupToken({
        customer_id: "cus_123",
        return_url: RETURN_URL,
        cancel_url: CANCEL_URL,
      }),
    ).resolves.toEqual({
      setup_token_id: "SETUP-1",
      approve_url: APPROVE_URL,
    });
  });

  it("falls back to the payer-action link when no approve link is present", async () => {
    const mock = makeMockVaultController();
    mock.createSetupToken.mockResolvedValue({
      result: {
        id: "SETUP-1",
        links: [
          { rel: "self", href: "https://api-m.sandbox.paypal.com/v3/vault/setup-tokens/SETUP-1" },
          { rel: "payer-action", href: PAYER_ACTION_URL },
        ],
      },
    });
    const client = makeClient(mock);

    await expect(
      client.createVaultSetupToken({
        customer_id: "cus_123",
        return_url: RETURN_URL,
        cancel_url: CANCEL_URL,
      }),
    ).resolves.toEqual({
      setup_token_id: "SETUP-1",
      approve_url: PAYER_ACTION_URL,
    });
  });

  it("rejects a response without an approval link as UNEXPECTED_STATE", async () => {
    const mock = makeMockVaultController();
    mock.createSetupToken.mockResolvedValue({
      result: { id: "SETUP-1", links: [] },
    });
    const client = makeClient(mock);

    const error = await captureRejection(
      client.createVaultSetupToken({
        customer_id: "cus_123",
        return_url: RETURN_URL,
        cancel_url: CANCEL_URL,
      }),
    );

    expect(error.type).toBe(MedusaError.Types.UNEXPECTED_STATE);
    expect(error.message).toContain("payer approval link");
  });

  it("rejects a response without a setup token id as UNEXPECTED_STATE", async () => {
    const mock = makeMockVaultController();
    mock.createSetupToken.mockResolvedValue({
      result: { links: [{ rel: "approve", href: APPROVE_URL }] },
    });
    const client = makeClient(mock);

    const error = await captureRejection(
      client.createVaultSetupToken({
        customer_id: "cus_123",
        return_url: RETURN_URL,
        cancel_url: CANCEL_URL,
      }),
    );

    expect(error.type).toBe(MedusaError.Types.UNEXPECTED_STATE);
    expect(error.message).toContain("setup token id");
  });
});

describe("PaypalService.createVaultSetupToken URL validation", () => {
  const invalidUrls: [string, "return_url" | "cancel_url"][] = [
    ["/paypal/return", "return_url"],
    ["javascript:alert(1)", "return_url"],
    ["mailto:buyer@example.com", "cancel_url"],
  ];

  it.each(invalidUrls)(
    "rejects %s as INVALID_DATA before calling PayPal (%s)",
    async (badUrl, field) => {
      const mock = makeMockVaultController();
      const client = makeClient(mock);

      const error = await captureRejection(
        client.createVaultSetupToken({
          customer_id: "cus_123",
          return_url: RETURN_URL,
          cancel_url: CANCEL_URL,
          [field]: badUrl,
        }),
      );

      // INVALID_DATA, never re-wrapped as UNEXPECTED_STATE: a caller bug is
      // not an upstream vault failure.
      expect(error.type).toBe(MedusaError.Types.INVALID_DATA);
      expect(error.message).toContain(field);
      expect(mock.createSetupToken).not.toHaveBeenCalled();
    },
  );
});

describe("PaypalService.getVaultSetupToken", () => {
  it("surfaces the status as a string with the response id", async () => {
    const mock = makeMockVaultController();
    mock.getSetupToken.mockResolvedValue({
      result: {
        id: "SETUP-1",
        status: "VAULTED",
        links: [{ rel: "payer-action", href: PAYER_ACTION_URL }],
      },
    });
    const client = makeClient(mock);

    const state = await client.getVaultSetupToken("SETUP-1");

    expect(mock.getSetupToken).toHaveBeenCalledWith("SETUP-1");
    expect(typeof state.status).toBe("string");
    expect(state).toEqual({
      setup_token_id: "SETUP-1",
      status: "VAULTED",
      approve_url: PAYER_ACTION_URL,
    });
  });

  it("rejects a response without a status as UNEXPECTED_STATE", async () => {
    const mock = makeMockVaultController();
    mock.getSetupToken.mockResolvedValue({ result: {} });
    const client = makeClient(mock);

    const error = await captureRejection(client.getVaultSetupToken("SETUP-9"));

    expect(error.type).toBe(MedusaError.Types.UNEXPECTED_STATE);
    expect(error.message).toContain("missing the status");
    // The setup token id is a secret: it must not reach the message.
    expect(error.message).not.toContain("SETUP-9");
    expectNotClassifierPreserved(error.type);
  });
});

describe("PaypalService.listVaultedPaymentMethods", () => {
  const notFound = {
    statusCode: 404,
    result: {
      name: "RESOURCE_NOT_FOUND",
      details: [{ issue: "CUSTOMER_ID_NOT_FOUND" }],
    },
  };

  it("queries PayPal with the derived 22-character customer id", async () => {
    const mock = makeMockVaultController();
    mock.listCustomerPaymentTokens.mockResolvedValue({
      result: { paymentTokens: [{ id: "VAULT-1" }] },
    });
    const client = makeClient(mock);

    const tokens = await client.listVaultedPaymentMethods("cus_123");

    expect(mock.listCustomerPaymentTokens).toHaveBeenCalledWith({
      customerId: derivePaypalCustomerId("cus_123"),
    });
    expect(tokens).toEqual([{ id: "VAULT-1" }]);
  });

  it("returns an empty list when the customer has no vaulted tokens", async () => {
    const mock = makeMockVaultController();
    mock.listCustomerPaymentTokens.mockRejectedValue(notFound);
    const client = makeClient(mock);

    await expect(client.listVaultedPaymentMethods("cus_123")).resolves.toEqual(
      [],
    );
  });

  it("propagates a 404 that is not CUSTOMER_ID_NOT_FOUND", async () => {
    const mock = makeMockVaultController();
    const failure = {
      statusCode: 404,
      result: {
        name: "RESOURCE_NOT_FOUND",
        details: [{ issue: "INVALID_RESOURCE_ID" }],
      },
    };
    mock.listCustomerPaymentTokens.mockRejectedValue(failure);
    const client = makeClient(mock);

    await expect(client.listVaultedPaymentMethods("cus_123")).rejects.toBe(
      failure,
    );
  });

  it("propagates a 500", async () => {
    const mock = makeMockVaultController();
    const failure = {
      statusCode: 500,
      result: { name: "INTERNAL_SERVER_ERROR" },
    };
    mock.listCustomerPaymentTokens.mockRejectedValue(failure);
    const client = makeClient(mock);

    await expect(client.listVaultedPaymentMethods("cus_123")).rejects.toBe(
      failure,
    );
  });

  it("propagates a 400 INVALID_STRING_LENGTH instead of mapping it to an empty list", async () => {
    const mock = makeMockVaultController();
    const failure = {
      statusCode: 400,
      result: {
        name: "INVALID_REQUEST",
        details: [{ issue: "INVALID_STRING_LENGTH" }],
      },
    };
    mock.listCustomerPaymentTokens.mockRejectedValue(failure);
    const client = makeClient(mock);

    await expect(client.listVaultedPaymentMethods("cus_123")).rejects.toBe(
      failure,
    );
  });
});

describe("PaypalService.createVaultPaymentToken", () => {
  it("exchanges the setup token and returns the vault id with the merchant customer id", async () => {
    const mock = makeMockVaultController();
    mock.createPaymentToken.mockResolvedValue({
      result: { id: "VAULT-1", customer: { merchantCustomerId: "cus_123" } },
    });
    const client = makeClient(mock);

    const token = await client.createVaultPaymentToken("SETUP-1");

    expect(mock.createPaymentToken).toHaveBeenCalledWith({
      body: {
        paymentSource: { token: { id: "SETUP-1", type: "SETUP_TOKEN" } },
      },
    });
    expect(token).toEqual({ vault_id: "VAULT-1", customer_id: "cus_123" });
  });

  it("rejects a response without a payment token id as UNEXPECTED_STATE", async () => {
    const mock = makeMockVaultController();
    mock.createPaymentToken.mockResolvedValue({ result: {} });
    const client = makeClient(mock);

    const error = await captureRejection(
      client.createVaultPaymentToken("SETUP-1"),
    );

    expect(error.type).toBe(MedusaError.Types.UNEXPECTED_STATE);
    expect(error.message).toContain("payment token id");
  });
});

describe("PaypalService vault upstream failures", () => {
  it("wraps a setup token failure as UNEXPECTED_STATE without echoing PayPal's description", async () => {
    const mock = makeMockVaultController();
    mock.createSetupToken.mockRejectedValue(upstreamFailure);
    const client = makeClient(mock);

    const error = await captureRejection(
      client.createVaultSetupToken({
        customer_id: "cus_123",
        return_url: RETURN_URL,
        cancel_url: CANCEL_URL,
      }),
    );

    expect(error.type).toBe(MedusaError.Types.UNEXPECTED_STATE);
    expect(error.message).toContain("SETUP_TOKEN_ID_NOT_FOUND");
    expect(error.message).toContain("422");
    // The PayPal description echoes the setup token id - red line.
    expect(error.message).not.toContain("SETUP-SECRET-123");
    expectNotClassifierPreserved(error.type);
  });

  it("wraps a payment token failure as UNEXPECTED_STATE without echoing PayPal's description", async () => {
    const mock = makeMockVaultController();
    mock.createPaymentToken.mockRejectedValue(upstreamFailure);
    const client = makeClient(mock);

    const error = await captureRejection(
      client.createVaultPaymentToken("SETUP-SECRET-123"),
    );

    expect(error.type).toBe(MedusaError.Types.UNEXPECTED_STATE);
    expect(error.message).toContain("SETUP_TOKEN_ID_NOT_FOUND");
    expect(error.message).toContain("422");
    expect(error.message).not.toContain("SETUP-SECRET-123");
    expectNotClassifierPreserved(error.type);
  });

  it("reads the issue code out of a JSON string body", async () => {
    const mock = makeMockVaultController();
    mock.getSetupToken.mockRejectedValue({
      statusCode: 500,
      body: JSON.stringify({
        name: "INTERNAL_SERVER_ERROR",
        message: "Setup token SETUP-SECRET-123 blew up",
      }),
    });
    const client = makeClient(mock);

    const error = await captureRejection(client.getVaultSetupToken("SETUP-1"));

    expect(error.type).toBe(MedusaError.Types.UNEXPECTED_STATE);
    expect(error.message).toContain("INTERNAL_SERVER_ERROR");
    expect(error.message).toContain("500");
    expect(error.message).not.toContain("SETUP-SECRET-123");
  });
});

describe("PaypalService SDK logging", () => {
  /**
   * The red line is "never log a setup token, a vault id or an approval URL".
   * Supplying a `logging` object makes the SDK build its ConsoleLogger, which
   * prints the request URL line - and `getSetupToken` issues
   * `GET /v3/vault/setup-tokens/{id}`, so the id lands on stdout on every
   * approval check. A mocked-controller test cannot see that, so this pins
   * the absence of a `logging` block: a future re-add would otherwise go
   * unnoticed.
   */
  it("leaves the SDK client on the SDK's no-op logger with body logging off", () => {
    const client = new PaypalService({
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      isSandbox: true,
      includeShippingData: false,
      includeCustomerData: false,
    });

    const { _loggingOp } = (
      client as unknown as {
        client: {
          _loggingOp: {
            logger: { constructor: { name: string } };
            logRequest: { logBody: boolean };
          };
        };
      }
    ).client;

    expect(_loggingOp.logger.constructor.name).toBe("NullLogger");
    expect(_loggingOp.logRequest.logBody).toBe(false);
  });
});

describe("PaypalService.createOrder vault branches", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * `createOrder` builds its own OrdersController from the SDK client, so the
   * order body is captured at the prototype method.
   */
  function spyOnCreateOrder() {
    const spy = jest.spyOn(OrdersController.prototype, "createOrder");

    spy.mockResolvedValue({ result: { id: "ORDER-1" } } as never);

    return spy;
  }

  it("sends the derived customer id and the permit-multiple flag when vaulting at checkout", async () => {
    const client = makeClient(makeMockVaultController());
    const spy = spyOnCreateOrder();

    await client.createOrder({
      amount: 10,
      currency: "USD",
      fractionDigits: 2,
      vaultCustomerId: "cus_123",
      return_url: RETURN_URL,
      cancel_url: CANCEL_URL,
    });

    const [{ body }] = spy.mock.calls[0];
    const attributes = body.paymentSource?.paypal?.attributes;

    expect(attributes?.vault?.permitMultiplePaymentTokens).toBe(true);
    // Orders v2 rejects `customer.id` and `customer.merchant_customer_id`
    // together (422 INCOMPATIBLE_PARAMETER_VALUE), so the checkout branch
    // sends only the derived id.
    expect(attributes?.customer).toEqual({
      id: derivePaypalCustomerId("cus_123"),
    });
    expect(attributes?.customer).not.toHaveProperty("merchantCustomerId");
  });

  it("charges a vault id off-session without a customer object", async () => {
    const client = makeClient(makeMockVaultController());
    const spy = spyOnCreateOrder();

    await client.createOrder({
      amount: 10,
      currency: "USD",
      fractionDigits: 2,
      vaultId: "VAULT-1",
      sessionId: "sess_1",
    });

    const [{ body }] = spy.mock.calls[0];

    expect(body.paymentSource?.paypal?.vaultId).toBe("VAULT-1");
    expect(body.paymentSource?.paypal?.attributes).toBeUndefined();
  });
});
