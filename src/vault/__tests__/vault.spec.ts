import { MedusaError } from "@medusajs/framework/utils";
import { completeVaultApproval, startVaultApproval } from "../index";
import type { PaypalService } from "../../providers/paypal/paypal-core/paypal-core";

type VaultClientStub = {
  createVaultSetupToken: jest.Mock;
  getVaultSetupToken: jest.Mock;
  createVaultPaymentToken: jest.Mock;
};

/** The flow only calls these three methods, so a stub cast to PaypalService is enough. */
function makeClient(): { client: PaypalService; stub: VaultClientStub } {
  const stub: VaultClientStub = {
    createVaultSetupToken: jest.fn(),
    getVaultSetupToken: jest.fn(),
    createVaultPaymentToken: jest.fn(),
  };

  return { client: stub as unknown as PaypalService, stub };
}

const input = {
  customer_id: "cus_1",
  return_url: "https://shop.test/return",
  cancel_url: "https://shop.test/cancel",
};

describe("startVaultApproval", () => {
  it("passes the input through and returns the setup token id and approval url", async () => {
    const { client, stub } = makeClient();

    stub.createVaultSetupToken.mockResolvedValue({
      setup_token_id: "st_1",
      approve_url: "https://paypal.test/approve",
    });

    await expect(startVaultApproval(client, input)).resolves.toEqual({
      setup_token_id: "st_1",
      approve_url: "https://paypal.test/approve",
    });
    expect(stub.createVaultSetupToken).toHaveBeenCalledTimes(1);
    expect(stub.createVaultSetupToken).toHaveBeenCalledWith(input);
  });
});

describe("completeVaultApproval", () => {
  it("returns the status and no vault id while the payer has not approved", async () => {
    const { client, stub } = makeClient();

    stub.getVaultSetupToken.mockResolvedValue({
      setup_token_id: "st_1",
      status: "PAYER_ACTION_REQUIRED",
    });

    const result = await completeVaultApproval(client, { setup_token_id: "st_1" });

    expect(result).toEqual({ status: "PAYER_ACTION_REQUIRED" });
    expect(result).not.toHaveProperty("vault_id");
    expect(stub.createVaultPaymentToken).not.toHaveBeenCalled();
  });

  it.each(["APPROVED", "VAULTED", "TOKENIZED"])(
    "exchanges a %s setup token for a vault id",
    async (status) => {
      const { client, stub } = makeClient();

      stub.getVaultSetupToken.mockResolvedValue({ setup_token_id: "st_1", status });
      stub.createVaultPaymentToken.mockResolvedValue({
        vault_id: "vault_1",
        customer_id: "cus_1",
      });

      await expect(
        completeVaultApproval(client, { setup_token_id: "st_1" })
      ).resolves.toEqual({
        status,
        vault_id: "vault_1",
        customer_id: "cus_1",
      });
      expect(stub.createVaultPaymentToken).toHaveBeenCalledTimes(1);
      expect(stub.createVaultPaymentToken).toHaveBeenCalledWith("st_1");
    }
  );

  it("propagates a client rejection unchanged", async () => {
    const { client, stub } = makeClient();
    const failure = new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "PayPal vault lookup failed"
    );

    stub.getVaultSetupToken.mockRejectedValue(failure);

    await expect(
      completeVaultApproval(client, { setup_token_id: "st_1" })
    ).rejects.toBe(failure);
  });
});
