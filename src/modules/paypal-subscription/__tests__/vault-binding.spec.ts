import { MedusaError } from "@medusajs/framework/utils";
import PaypalSubscriptionModuleService, {
  PaypalSubscriptionModuleOptions,
} from "../service";
import type { PaypalService } from "../../../providers/paypal/paypal-core/paypal-core";
import { PAYPAL_VAULT_BINDING_CAPABILITY } from "../../../index";
import { PAYPAL_VAULT_BINDING_CAPABILITY as MODULE_CAPABILITY } from "../../../vault";

type Container = ConstructorParameters<typeof PaypalSubscriptionModuleService>[0];

type VaultClientStub = {
  createVaultSetupToken: jest.Mock;
  getVaultSetupToken: jest.Mock;
  createVaultPaymentToken: jest.Mock;
};

/** The service only calls these three methods, so a stub cast to PaypalService is enough. */
function makeClient(): { client: PaypalService; stub: VaultClientStub } {
  const stub: VaultClientStub = {
    createVaultSetupToken: jest.fn(),
    getVaultSetupToken: jest.fn(),
    createVaultPaymentToken: jest.fn(),
  };

  return { client: stub as unknown as PaypalService, stub };
}

type CrudStubs = {
  listPaypalSettings: jest.Mock;
  createPaypalSettings: jest.Mock;
  updatePaypalSettings: jest.Mock;
  createPaypalSettingsAudits: jest.Mock;
};

/**
 * In-memory stand-in for the MedusaService-generated CRUD (which needs a real
 * container). Every other method on the service runs for real.
 */
function makeService(options: PaypalSubscriptionModuleOptions = {}): {
  service: PaypalSubscriptionModuleService;
  crud: CrudStubs;
} {
  const logger = {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  const service = new PaypalSubscriptionModuleService(
    { logger } as unknown as Container,
    options
  );

  const crud = service as unknown as CrudStubs;

  crud.listPaypalSettings = jest.fn(async () => [] as Record<string, unknown>[]);
  crud.createPaypalSettings = jest.fn(async (data: unknown) => data);
  crud.updatePaypalSettings = jest.fn(async (data: unknown) => data);
  crud.createPaypalSettingsAudits = jest.fn(async (data: unknown) => data);

  return { service, crud };
}

function overrideVaultClient(
  service: PaypalSubscriptionModuleService,
  client: PaypalService
): void {
  (
    service as unknown as { getVaultClient: () => Promise<PaypalService> }
  ).getVaultClient = async () => client;
}

const input = {
  customer_id: "cus_1",
  return_url: "https://shop.test/return",
  cancel_url: "https://shop.test/cancel",
};

describe("PaypalSubscriptionModuleService vault binding", () => {
  it("returns the approval url and passes the input through", async () => {
    const { service, crud } = makeService();
    const { client, stub } = makeClient();

    stub.createVaultSetupToken.mockResolvedValue({
      setup_token_id: "st_1",
      approve_url: "https://paypal.test/approve",
    });
    overrideVaultClient(service, client);

    await expect(service.startVaultApproval(input)).resolves.toEqual({
      setup_token_id: "st_1",
      approve_url: "https://paypal.test/approve",
    });

    expect(stub.createVaultSetupToken).toHaveBeenCalledWith(input);
    expect(crud.listPaypalSettings).not.toHaveBeenCalled();
    expect(crud.createPaypalSettings).not.toHaveBeenCalled();
    expect(crud.updatePaypalSettings).not.toHaveBeenCalled();
  });

  it("reports the status with no vault id while the payer has not approved", async () => {
    const { service } = makeService();
    const { client, stub } = makeClient();

    stub.getVaultSetupToken.mockResolvedValue({
      setup_token_id: "st_1",
      status: "PAYER_ACTION_REQUIRED",
    });
    overrideVaultClient(service, client);

    const result = await service.completeVaultApproval({ setup_token_id: "st_1" });

    expect(result).toEqual({ status: "PAYER_ACTION_REQUIRED" });
    expect(result).not.toHaveProperty("vault_id");
    expect(stub.createVaultPaymentToken).not.toHaveBeenCalled();
  });

  it("exchanges an approved setup token and returns the vault id", async () => {
    const { service } = makeService();
    const { client, stub } = makeClient();

    stub.getVaultSetupToken.mockResolvedValue({ setup_token_id: "st_1", status: "VAULTED" });
    stub.createVaultPaymentToken.mockResolvedValue({
      vault_id: "vault_1",
      customer_id: "cus_1",
    });
    overrideVaultClient(service, client);

    await expect(
      service.completeVaultApproval({ setup_token_id: "st_1" })
    ).resolves.toEqual({
      status: "VAULTED",
      vault_id: "vault_1",
      customer_id: "cus_1",
    });
    expect(stub.createVaultPaymentToken).toHaveBeenCalledWith("st_1");
  });

  it("propagates an upstream failure as UNEXPECTED_STATE, never as a refusal", async () => {
    const { service } = makeService();
    const { client, stub } = makeClient();
    const failure = new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "PayPal vault lookup failed"
    );

    stub.getVaultSetupToken.mockRejectedValue(failure);
    overrideVaultClient(service, client);

    await expect(
      service.completeVaultApproval({ setup_token_id: "st_1" })
    ).rejects.toMatchObject({ type: MedusaError.Types.UNEXPECTED_STATE });
  });

  it("preserves a caller-side error type instead of re-wrapping it", async () => {
    const { service } = makeService();
    const { client, stub } = makeClient();
    const failure = new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "return_url must be an absolute http(s) url"
    );

    stub.createVaultSetupToken.mockRejectedValue(failure);
    overrideVaultClient(service, client);

    await expect(service.startVaultApproval(input)).rejects.toBe(failure);
  });

  it("resolves the client through the module's own config resolver", async () => {
    const { service, crud } = makeService();
    crud.listPaypalSettings.mockResolvedValue([
      { client_id: "db-id", client_secret: "db-secret" },
    ]);

    // The relative return_url is deliberate: the real client rejects it as
    // INVALID_DATA before any network call, so this stays a unit test.
    await expect(
      service.startVaultApproval({ ...input, return_url: "/paypal/return" })
    ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });

    expect(crud.listPaypalSettings).toHaveBeenCalledWith({ id: "ppset_singleton" });
    expect(crud.updatePaypalSettings).not.toHaveBeenCalled();
  });

  it("wraps an unconfigured plugin into UNEXPECTED_STATE through the real client accessor", async () => {
    const { service, crud } = makeService();

    crud.listPaypalSettings.mockResolvedValue([]);

    await expect(service.startVaultApproval(input)).rejects.toMatchObject({
      type: MedusaError.Types.UNEXPECTED_STATE,
      message: expect.stringContaining("not configured"),
    });
  });

  it("exposes the duck-type surface and the capability name", () => {
    const { service } = makeService();

    expect(typeof service.startVaultApproval).toBe("function");
    expect(typeof service.completeVaultApproval).toBe("function");
    expect(MODULE_CAPABILITY).toBe("vault-binding");
  });

  it("re-exports the capability constant from the package root", () => {
    expect(PAYPAL_VAULT_BINDING_CAPABILITY).toBe(MODULE_CAPABILITY);
    expect(PAYPAL_VAULT_BINDING_CAPABILITY).toBe("vault-binding");
  });
});
