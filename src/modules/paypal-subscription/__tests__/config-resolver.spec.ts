import { MedusaError } from "@medusajs/framework/utils";
import PaypalSubscriptionModuleService from "../service";
import {
  assertPaypalConfigured,
  maskSecret,
  mergePaypalConfigLayers,
} from "../lib/config-resolver";
import {
  PaypalSubscriptionConfig,
  planConfigHash,
} from "../../../subscription/metadata";

const SINGLETON_ID = "ppset_singleton";

const loggerStub = () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

/**
 * In-memory stand-in for the MedusaService-generated CRUD (which needs a real
 * container). Everything else on the service runs for real.
 */
function makeService(options: Record<string, unknown> = {}) {
  const logger = loggerStub();
  const service = new PaypalSubscriptionModuleService(
    { logger } as any,
    options as any
  );

  const rows: any[] = [];
  const audits: any[] = [];

  (service as any).listPaypalSettings = jest.fn(async (filters: any = {}) =>
    rows.filter((row) =>
      Object.entries(filters).every(([key, value]) => row[key] === value)
    )
  );
  (service as any).createPaypalSettings = jest.fn(async (data: any) => {
    rows.push({ ...data });
    return data;
  });
  (service as any).updatePaypalSettings = jest.fn(async (data: any) => {
    const row = rows.find((candidate) => candidate.id === data.id);

    if (!row) {
      throw new Error(`no settings row ${data.id}`);
    }

    Object.assign(row, data);
    return row;
  });
  (service as any).createPaypalSettingsAudits = jest.fn(async (data: any) => {
    audits.push(data);
    return data;
  });

  return { service, logger, rows, audits };
}

describe("mergePaypalConfigLayers", () => {
  it("falls back per field through db -> provider options -> plugin options", () => {
    const { config, sources } = mergePaypalConfigLayers({
      db: { client_id: "db-id", client_secret: "db-secret" },
      providerOptions: {
        clientId: "provider-id",
        webhookId: "provider-webhook",
        paymentFailureThreshold: 7,
      },
      pluginOptions: {
        clientId: "plugin-id",
        isSandbox: true,
        autoBillOutstanding: true,
      },
    });

    expect(config).toEqual({
      clientId: "db-id",
      clientSecret: "db-secret",
      isSandbox: true,
      webhookId: "provider-webhook",
      subscriptionWebhookId: undefined,
      includeShippingData: false,
      includeCustomerData: false,
      autoBillOutstanding: true,
      paymentFailureThreshold: 7,
    });

    expect(sources).toEqual({
      clientId: "db",
      clientSecret: "db",
      isSandbox: "plugin_options",
      webhookId: "provider_options",
      subscriptionWebhookId: "none",
      includeShippingData: "none",
      includeCustomerData: "none",
      autoBillOutstanding: "plugin_options",
      paymentFailureThreshold: "provider_options",
    });
  });

  it("treats blank strings as not provided", () => {
    const { config, sources } = mergePaypalConfigLayers({
      db: { client_id: "   ", webhook_id: "" },
      providerOptions: { clientId: "provider-id", webhookId: "  " },
      pluginOptions: { webhookId: "plugin-webhook" },
    });

    expect(config.clientId).toBe("provider-id");
    expect(config.webhookId).toBe("plugin-webhook");
    expect(sources.clientId).toBe("provider_options");
    expect(sources.webhookId).toBe("plugin_options");
  });

  it("keeps false as a provided value instead of inheriting", () => {
    const { config, sources } = mergePaypalConfigLayers({
      providerOptions: { isSandbox: false, includeShippingData: false },
      pluginOptions: { isSandbox: true, includeShippingData: true },
    });

    expect(config.isSandbox).toBe(false);
    expect(config.includeShippingData).toBe(false);
    expect(sources.isSandbox).toBe("provider_options");
    expect(sources.includeShippingData).toBe("provider_options");
  });

  it("applies schema defaults without claiming a source", () => {
    const { config, sources } = mergePaypalConfigLayers({});

    expect(config.isSandbox).toBe(false);
    expect(config.includeShippingData).toBe(false);
    expect(config.includeCustomerData).toBe(false);
    expect(config.autoBillOutstanding).toBeUndefined();
    expect(config.paymentFailureThreshold).toBeUndefined();
    expect(new Set(Object.values(sources))).toEqual(new Set(["none"]));
  });

  it("reads the db layer from snake_case columns only", () => {
    const { config, sources } = mergePaypalConfigLayers({
      db: {
        client_id: "db-id",
        is_sandbox: true,
        include_customer_data: true,
        payment_failure_threshold: 5,
        clientId: "camel-case-is-not-a-column",
      },
    });

    expect(config.clientId).toBe("db-id");
    expect(config.isSandbox).toBe(true);
    expect(config.includeCustomerData).toBe(true);
    expect(config.paymentFailureThreshold).toBe(5);
    expect(sources.clientId).toBe("db");
  });

  it("ignores null in a higher layer and keeps looking down the chain", () => {
    const { config, sources } = mergePaypalConfigLayers({
      db: { client_id: null, webhook_id: null },
      providerOptions: { clientId: "provider-id" },
      pluginOptions: { webhookId: "plugin-webhook" },
    });

    expect(config.clientId).toBe("provider-id");
    expect(config.webhookId).toBe("plugin-webhook");
    expect(sources.clientId).toBe("provider_options");
    expect(sources.webhookId).toBe("plugin_options");
  });
});

describe("maskSecret", () => {
  it("returns null for empty and blank secrets", () => {
    expect(maskSecret(null)).toBeNull();
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret("")).toBeNull();
    expect(maskSecret("   ")).toBeNull();
  });

  it("keeps only the last four characters", () => {
    expect(maskSecret("super-secret-1234")).toBe("••••1234");
    expect(maskSecret("abcd")).toBe("••••abcd");
    expect(maskSecret("abc")).toBe("••••abc");
  });
});

describe("assertPaypalConfigured", () => {
  const configured = {
    clientId: "id",
    clientSecret: "secret",
    isSandbox: false,
    includeShippingData: false,
    includeCustomerData: false,
  };

  it("passes a fully configured resolution", () => {
    expect(() => assertPaypalConfigured(configured)).not.toThrow();
  });

  it("throws INVALID_DATA with the settings-page message when a credential is blank", () => {
    expect(() =>
      assertPaypalConfigured({ ...configured, clientSecret: "   " })
    ).toThrow(MedusaError);

    try {
      assertPaypalConfigured({ ...configured, clientId: undefined });
      throw new Error("expected assertPaypalConfigured to throw");
    } catch (error) {
      expect(error).toMatchObject({
        type: MedusaError.Types.INVALID_DATA,
        message: expect.stringContaining("admin PayPal settings page"),
      });
    }
  });
});

describe("module service engine caching", () => {
  it("reuses the engine while the resolved config is stable and rebuilds it on a version bump", async () => {
    const { service } = makeService({
      clientId: "plugin-id",
      clientSecret: "plugin-secret",
      autoBillOutstanding: true,
    });

    const first = await (service as any).resolveEngine();

    expect(await (service as any).resolveEngine()).toBe(first);

    await service.savePaypalSettings({
      values: { autoBillOutstanding: false, paymentFailureThreshold: 7 },
    });

    const rebuilt = await (service as any).resolveEngine();

    expect(rebuilt).not.toBe(first);
    expect((rebuilt as any).deps.options).toEqual({
      autoBillOutstanding: false,
      paymentFailureThreshold: 7,
    });
  });

  it("refuses to build an engine while the credentials are missing", async () => {
    const { service } = makeService();

    await expect((service as any).resolveEngine()).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringContaining("PayPal is not configured"),
    });
  });
});

describe("getResolvedPaypalConfig", () => {
  afterEach(() => {
    delete process.env.PAYPAL_IGNORE_DB_SETTINGS;
  });

  it("uses plugin options as the last fallback layer", async () => {
    const { service } = makeService({
      clientId: "plugin-id",
      clientSecret: "plugin-secret",
      isSandbox: true,
      autoBillOutstanding: true,
    });

    const resolved = await service.getResolvedPaypalConfig();

    expect(resolved.config.clientId).toBe("plugin-id");
    expect(resolved.config.clientSecret).toBe("plugin-secret");
    expect(resolved.config.isSandbox).toBe(true);
    expect(resolved.config.autoBillOutstanding).toBe(true);
    expect(resolved.sources.clientId).toBe("plugin_options");
    expect(resolved.version).toBe(0);
    expect(resolved.meta).toEqual({
      lastModifiedBy: null,
      lastModifiedAt: null,
      lastVerifiedAt: null,
      lastVerifiedOk: null,
    });
  });

  it("lets provider options override plugin options and db override both", async () => {
    const { service } = makeService({ clientId: "plugin-id" });

    await service.savePaypalSettings({ values: { clientId: "db-id" } });

    const resolved = await service.getResolvedPaypalConfig({
      providerOptions: { clientId: "provider-id", webhookId: "provider-wh" },
    });

    expect(resolved.config.clientId).toBe("db-id");
    expect(resolved.sources.clientId).toBe("db");
    expect(resolved.config.webhookId).toBe("provider-wh");
    expect(resolved.sources.webhookId).toBe("provider_options");
  });

  it("reports the row version and modification/verification meta", async () => {
    const { service } = makeService();

    await service.savePaypalSettings({
      values: { clientId: "db-id" },
      actorId: "user_1",
    });
    await service.savePaypalSettings({
      values: { isSandbox: true },
      actorId: "user_2",
    });
    await service.recordPaypalSettingsVerification({
      ok: false,
      at: new Date("2026-09-29T08:30:00.000Z"),
    });

    const resolved = await service.getResolvedPaypalConfig();

    expect(resolved.version).toBe(2);
    expect(resolved.config.clientId).toBe("db-id");
    expect(resolved.config.isSandbox).toBe(true);
    expect(resolved.meta.lastModifiedBy).toBe("user_2");
    expect(resolved.meta.lastModifiedAt).not.toBeNull();
    expect(resolved.meta.lastVerifiedAt).toBe("2026-09-29T08:30:00.000Z");
    expect(resolved.meta.lastVerifiedOk).toBe(false);
  });

  it("keeps the version stable across reads so consumers can reuse their cache", async () => {
    const { service } = makeService();

    const empty = await service.getResolvedPaypalConfig();
    const emptyAgain = await service.getResolvedPaypalConfig();

    expect(empty.version).toBe(0);
    expect(emptyAgain.version).toBe(0);

    await service.savePaypalSettings({ values: { clientId: "db-id" } });

    const afterWrite = await service.getResolvedPaypalConfig();
    const afterWriteAgain = await service.getResolvedPaypalConfig();

    expect(afterWrite.version).toBe(1);
    expect(afterWriteAgain.version).toBe(1);
  });

  it("skips the db read entirely when PAYPAL_IGNORE_DB_SETTINGS is truthy", async () => {
    const { service } = makeService({ clientId: "plugin-id" });

    await service.savePaypalSettings({ values: { clientId: "db-id" } });
    (service as any).listPaypalSettings.mockClear();

    for (const raw of ["1", "true", "YES", "On"]) {
      process.env.PAYPAL_IGNORE_DB_SETTINGS = raw;

      const resolved = await service.getResolvedPaypalConfig();

      expect(resolved.version).toBe(0);
      expect(resolved.config.clientId).toBe("plugin-id");
      expect(resolved.sources.clientId).toBe("plugin_options");
    }

    expect((service as any).listPaypalSettings).not.toHaveBeenCalled();
  });

  it("keeps reading the db layer for falsy kill-switch values", async () => {
    const { service } = makeService();

    await service.savePaypalSettings({ values: { clientId: "db-id" } });

    process.env.PAYPAL_IGNORE_DB_SETTINGS = "0";

    const resolved = await service.getResolvedPaypalConfig();

    expect(resolved.version).toBe(1);
    expect(resolved.config.clientId).toBe("db-id");
  });

  it("degrades to the config layers, warning once, when the read throws", async () => {
    const { service, logger } = makeService({ clientId: "plugin-id" });

    (service as any).listPaypalSettings = jest
      .fn()
      .mockRejectedValue(
        new Error('relation "paypal_settings" does not exist')
      );

    const first = await service.getResolvedPaypalConfig({
      providerOptions: { clientId: "provider-id" },
    });
    const second = await service.getResolvedPaypalConfig();

    expect(first.config.clientId).toBe("provider-id");
    expect(first.version).toBe(0);
    expect(first.sources.clientId).toBe("provider_options");
    expect(second.config.clientId).toBe("plugin-id");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/db:migrate/);
  });
});

describe("savePaypalSettings", () => {
  it("creates the singleton row at version 1 and audits the diff", async () => {
    const { service, rows, audits } = makeService();

    const result = await service.savePaypalSettings({
      values: { clientId: "live-id", isSandbox: false },
      actorId: "user_1",
    });

    expect(result).toEqual({
      version: 1,
      changedFields: {
        clientId: { from: null, to: "live-id" },
        isSandbox: { from: null, to: false },
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: SINGLETON_ID,
      client_id: "live-id",
      is_sandbox: false,
      version: 1,
      last_modified_by: "user_1",
    });
    expect(rows[0].last_modified_at).toBeInstanceOf(Date);
    expect(audits).toEqual([
      {
        actor_id: "user_1",
        changed_fields: {
          clientId: { from: null, to: "live-id" },
          isSandbox: { from: null, to: false },
        },
      },
    ]);
  });

  it("increments the version and touches only the provided fields", async () => {
    const { service, rows } = makeService();

    await service.savePaypalSettings({
      values: { clientId: "first-id", webhookId: "wh_1" },
    });

    const result = await service.savePaypalSettings({
      values: { clientId: "second-id" },
      actorId: "user_2",
    });

    expect(result.version).toBe(2);
    expect(result.changedFields).toEqual({
      clientId: { from: "first-id", to: "second-id" },
    });
    expect(rows[0]).toMatchObject({
      client_id: "second-id",
      webhook_id: "wh_1",
      version: 2,
      last_modified_by: "user_2",
    });
  });

  it("masks client_secret on both sides of the diff, audit included", async () => {
    const { service, rows, audits } = makeService();

    const created = await service.savePaypalSettings({
      values: { clientSecret: "first-secret-abcd" },
    });

    expect(created.changedFields).toEqual({
      clientSecret: { from: null, to: "••••abcd" },
    });

    const updated = await service.savePaypalSettings({
      values: { clientSecret: "second-secret-wxyz" },
    });

    expect(updated.changedFields).toEqual({
      clientSecret: { from: "••••abcd", to: "••••wxyz" },
    });
    // The raw value is stored (the DB is the trust boundary) but never
    // surfaces in the audit trail or in what the caller gets back.
    expect(rows[0].client_secret).toBe("second-secret-wxyz");
    const serialized = JSON.stringify({ audits, changedFields: updated.changedFields });
    expect(serialized).not.toContain("first-secret-abcd");
    expect(serialized).not.toContain("second-secret-wxyz");
  });

  it("clears a field with an explicit null so it inherits again", async () => {
    const { service, rows } = makeService();

    await service.savePaypalSettings({ values: { clientId: "db-id" } });

    const result = await service.savePaypalSettings({
      values: { clientId: null },
    });

    expect(result.changedFields).toEqual({
      clientId: { from: "db-id", to: null },
    });
    expect(rows[0].client_id).toBeNull();

    const resolved = await service.getResolvedPaypalConfig({
      providerOptions: { clientId: "provider-id" },
    });

    expect(resolved.config.clientId).toBe("provider-id");
    expect(resolved.sources.clientId).toBe("provider_options");
  });

  it("rejects unknown keys without touching the row", async () => {
    const { service, rows, audits } = makeService();

    await expect(
      service.savePaypalSettings({ values: { clientId: "x", nope: 1 } })
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringContaining('"nope"'),
    });

    expect(rows).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("does nothing for an empty patch", async () => {
    const { service, rows, audits } = makeService();

    const result = await service.savePaypalSettings({ values: {} });

    expect(result).toEqual({ version: 0, changedFields: {} });
    expect(rows).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("propagates write failures instead of degrading", async () => {
    const { service } = makeService();

    (service as any).createPaypalSettings = jest
      .fn()
      .mockRejectedValue(new Error('relation "paypal_settings" does not exist'));

    await expect(
      service.savePaypalSettings({ values: { clientId: "db-id" } })
    ).rejects.toThrow(/paypal_settings/);
  });

  it("translates a missing paypal_settings table into a migration hint", async () => {
    const { service } = makeService();
    const missing = Object.assign(
      new Error('relation "paypal_settings" does not exist'),
      { name: "TableNotFoundException", code: "42P01" }
    );

    (service as any).listPaypalSettings = jest.fn().mockRejectedValue(missing);

    await expect(
      service.savePaypalSettings({ values: { clientId: "db-id" } })
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringMatching(
        /"paypal_settings"[\s\S]*npx medusa db:migrate/
      ),
    });
  });

  it("translates a raw undefined-table message even without the ORM error name", async () => {
    const { service } = makeService();

    (service as any).listPaypalSettings = jest
      .fn()
      .mockRejectedValue(
        new Error('relation "paypal_settings" does not exist')
      );

    await expect(
      service.savePaypalSettings({ values: { clientId: "db-id" } })
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringContaining("db:migrate"),
    });
  });

  it("does not rewrite unrelated read failures", async () => {
    const { service } = makeService();
    const unrelated = new Error("connection refused");

    (service as any).listPaypalSettings = jest
      .fn()
      .mockRejectedValue(unrelated);

    await expect(
      service.savePaypalSettings({ values: { clientId: "db-id" } })
    ).rejects.toBe(unrelated);
  });
});

describe("recordPaypalSettingsVerification", () => {
  it("stores the verification result without a version bump or audit row", async () => {
    const { service, rows, audits } = makeService();

    await service.savePaypalSettings({ values: { clientId: "db-id" } });

    await service.recordPaypalSettingsVerification({
      ok: true,
      at: new Date("2026-09-29T09:00:00.000Z"),
    });

    expect(rows[0]).toMatchObject({
      version: 1,
      last_verified_ok: true,
    });
    expect(rows[0].last_verified_at).toEqual(
      new Date("2026-09-29T09:00:00.000Z")
    );
    expect(audits).toHaveLength(1);
  });

  it("is a silent no-op when no settings row exists", async () => {
    const { service, rows, audits } = makeService();

    await service.recordPaypalSettingsVerification({ ok: true });

    expect(rows).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it("translates a missing table into the same migration hint", async () => {
    const { service } = makeService();

    (service as any).listPaypalSettings = jest.fn().mockRejectedValue(
      Object.assign(new Error('relation "paypal_settings" does not exist'), {
        name: "TableNotFoundException",
      })
    );

    await expect(
      service.recordPaypalSettingsVerification({ ok: true })
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringContaining("db:migrate"),
    });
  });

  it("does not rewrite unrelated failures", async () => {
    const { service } = makeService();
    const unrelated = new Error("connection terminated unexpectedly");

    (service as any).listPaypalSettings = jest
      .fn()
      .mockRejectedValue(unrelated);

    await expect(
      service.recordPaypalSettingsVerification({ ok: true })
    ).rejects.toBe(unrelated);
  });
});

describe("planConfigHash environment binding", () => {
  const config: PaypalSubscriptionConfig = {
    interval_unit: "MONTH",
    interval_count: 1,
    product_type: "SERVICE",
    amount: 19.99,
    currency_code: "usd",
  };

  it("is stable within one environment", () => {
    const sandbox = planConfigHash(config, "sandbox");

    expect(sandbox).toBe(planConfigHash(config, "sandbox"));
    expect(sandbox).toMatch(/^[0-9a-f]{64}$/);
    expect(planConfigHash(config, "live")).toBe(
      planConfigHash(config, "live")
    );
  });

  it("differs across environments for identical plan configs", () => {
    expect(planConfigHash(config, "sandbox")).not.toBe(
      planConfigHash(config, "live")
    );
  });
});
