import { MedusaError } from "@medusajs/framework/utils";
import { PaypalService } from "../../providers/paypal/paypal-core/paypal-core";
import { ApprovalAlreadyUsedError, createPaypalBinder } from "../index";

/**
 * The binder builds its own PayPal client, so the vault calls are spied at the
 * prototype. That keeps the test on the contract the plugin consumes
 * (`start`/`complete`) while pinning the exact vault inputs passed through.
 */

function makeBinder() {
  return createPaypalBinder({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    isSandbox: true,
  });
}

const startInput = {
  customerId: "cus_1",
  providerId: "pp_paypal_paypal",
  returnUrl: "https://shop.test/payment/return",
  cancelUrl: "https://shop.test/payment/cancel",
};

const completeInput = {
  customerId: "cus_1",
  providerId: "pp_paypal_paypal",
  state: "st_1",
};

describe("createPaypalBinder start", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("creates a setup token and maps the approval url and state", async () => {
    const spy = jest
      .spyOn(PaypalService.prototype, "createVaultSetupToken")
      .mockResolvedValue({
        setup_token_id: "st_1",
        approve_url: "https://paypal.test/approve",
      });

    const binder = makeBinder();

    await expect(binder.start(startInput)).resolves.toEqual({
      approvalUrl: "https://paypal.test/approve",
      state: "st_1",
    });

    // returnUrl/cancelUrl are passed through untouched; the state is the
    // setup token id the host hands back to `complete`.
    expect(spy).toHaveBeenCalledWith({
      customer_id: "cus_1",
      return_url: "https://shop.test/payment/return",
      cancel_url: "https://shop.test/payment/cancel",
    });
  });

  it("propagates a vault failure unchanged", async () => {
    const failure = new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "PayPal vault create setup token failed",
    );

    jest
      .spyOn(PaypalService.prototype, "createVaultSetupToken")
      .mockRejectedValue(failure);

    await expect(makeBinder().start(startInput)).rejects.toBe(failure);
  });
});

describe("createPaypalBinder complete", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("exchanges an approved setup token for the payment method id", async () => {
    jest
      .spyOn(PaypalService.prototype, "getVaultSetupToken")
      .mockResolvedValue({ setup_token_id: "st_1", status: "VAULTED" });
    const exchange = jest
      .spyOn(PaypalService.prototype, "createVaultPaymentToken")
      .mockResolvedValue({ vault_id: "vault_1" });
    // Defect D1 regression lock: the reference is the vault id the exchange
    // returned, never one re-resolved by listing vault payment methods
    // (PayPal v3 read-after-write latency makes that list 409
    // bindingNotVerified right after a successful bind).
    const list = jest.spyOn(
      PaypalService.prototype,
      "listVaultedPaymentMethods",
    );

    await expect(makeBinder().complete(completeInput)).resolves.toEqual({
      paymentMethodId: "vault_1",
      data: { type: "paypal" },
    });
    expect(exchange).toHaveBeenCalledWith("st_1");
    expect(list).not.toHaveBeenCalled();
  });

  it("surfaces an already-used approval session as ApprovalAlreadyUsedError", async () => {
    jest
      .spyOn(PaypalService.prototype, "getVaultSetupToken")
      .mockResolvedValue({ setup_token_id: "st_1", status: "VAULTED" });

    const alreadyUsed = new ApprovalAlreadyUsedError();

    jest
      .spyOn(PaypalService.prototype, "createVaultPaymentToken")
      .mockRejectedValue(alreadyUsed);

    // The caller maps this by identity to an idempotent success with the
    // method the first complete created - it must arrive unharmed.
    await expect(makeBinder().complete(completeInput)).rejects.toBe(
      alreadyUsed,
    );
  });

  it("refuses a setup token the payer has not approved", async () => {
    jest
      .spyOn(PaypalService.prototype, "getVaultSetupToken")
      .mockResolvedValue({ setup_token_id: "st_1", status: "PAYER_ACTION_REQUIRED" });
    const exchange = jest.spyOn(
      PaypalService.prototype,
      "createVaultPaymentToken",
    );

    await expect(makeBinder().complete(completeInput)).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringContaining("PAYER_ACTION_REQUIRED"),
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it("propagates a vault failure unchanged", async () => {
    const failure = new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "PayPal vault get setup token failed",
    );

    jest
      .spyOn(PaypalService.prototype, "getVaultSetupToken")
      .mockRejectedValue(failure);

    await expect(makeBinder().complete(completeInput)).rejects.toBe(failure);
  });
});

describe("createPaypalBinder contract", () => {
  it("returns a binder with start and complete", () => {
    const binder = makeBinder();

    expect(typeof binder.start).toBe("function");
    expect(typeof binder.complete).toBe("function");
  });
});

describe("createPaypalBinder credential environment guard", () => {
  // Walkthrough R11 / #18: sandbox credentials must never run against the
  // live API and vice versa. The factory is the fail-fast point - a host
  // that declares which environment its credential set belongs to gets a
  // boot-time throw instead of binds against the wrong API.
  it("throws at startup when the declared credential environment contradicts isSandbox", () => {
    expect(() =>
      createPaypalBinder({
        clientId: "sandbox-client-id",
        clientSecret: "sandbox-client-secret",
        isSandbox: true,
        credentialEnvironment: "live",
      }),
    ).toThrow(expect.objectContaining({
      name: "PaypalCredentialEnvironmentMismatchError",
      message: expect.stringContaining("mismatch"),
    }));
  });

  it("refuses the mirror case: live credentials declared against a sandbox client", () => {
    expect(() =>
      createPaypalBinder({
        clientId: "live-client-id",
        clientSecret: "live-client-secret",
        isSandbox: false,
        credentialEnvironment: "sandbox",
      }),
    ).toThrow("PayPal credential environment mismatch");
  });

  it("accepts a declaration that agrees with isSandbox", () => {
    expect(() =>
      createPaypalBinder({
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        isSandbox: true,
        credentialEnvironment: "sandbox",
      }),
    ).not.toThrow();
  });

  it("accepts options without a declaration (nothing local to compare)", () => {
    expect(() => makeBinder()).not.toThrow();
  });
});
