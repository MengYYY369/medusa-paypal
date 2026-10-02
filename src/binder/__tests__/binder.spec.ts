import { MedusaError } from "@medusajs/framework/utils";
import { PaypalService } from "../../providers/paypal/paypal-core/paypal-core";
import { createPaypalBinder } from "../index";

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

    await expect(makeBinder().complete(completeInput)).resolves.toEqual({
      paymentMethodId: "vault_1",
      data: { type: "paypal" },
    });
    expect(exchange).toHaveBeenCalledWith("st_1");
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
