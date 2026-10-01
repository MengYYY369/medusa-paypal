import { MedusaError } from "@medusajs/framework/utils";
import { PaypalService } from "../paypal-core";

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
  customer?: { merchantCustomerId?: string };
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
};

function makeMockVaultController(): MockVaultController {
  return {
    createSetupToken: jest.fn(),
    getSetupToken: jest.fn(),
    createPaymentToken: jest.fn(),
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

describe("PaypalService.createVaultSetupToken", () => {
  it("sends the wallet vault body with a top-level merchant customer id", async () => {
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

    expect(body.customer).toEqual({ merchantCustomerId: "cus_123" });
    expect(body.paymentSource.paypal?.usageType).toBe("MERCHANT");
    expect(body.paymentSource.paypal?.experienceContext).toEqual({
      returnUrl: RETURN_URL,
      cancelUrl: CANCEL_URL,
      vaultInstruction: "ON_PAYER_APPROVAL",
    });
    // The wallet request object has no customer member: the id is top-level.
    expect(body.paymentSource.paypal).not.toHaveProperty("customer");
    // One wallet maps to one merchant customer (PayPal default, not sent).
    expect(
      body.paymentSource.paypal?.permitMultiplePaymentTokens,
    ).toBeUndefined();

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

  it("falls back to the requested id and an empty status", async () => {
    const mock = makeMockVaultController();
    mock.getSetupToken.mockResolvedValue({ result: {} });
    const client = makeClient(mock);

    const state = await client.getVaultSetupToken("SETUP-9");

    expect(state).toEqual({ setup_token_id: "SETUP-9", status: "" });
    expect(state.approve_url).toBeUndefined();
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
