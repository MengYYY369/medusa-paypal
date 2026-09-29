import {
  validateAndTransformBody,
  validateAndTransformQuery,
} from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import {
  AdminListPaypalSettingsAuditQuery,
  AdminTestPaypalSettingsBody,
  AdminUpdatePaypalSettingsBody,
} from "../middlewares";
import {
  resolveActorId,
  resolveRequestOrigin,
  sanitizeCredentialError,
  shapePaypalSettingsResponse,
} from "../admin/paypal/settings/utils";

/**
 * Runs one of the real middleware validators against a fake request. This is
 * what proves the 400 contract: `validateAndTransformBody` delegates to the
 * framework's `zodValidator`, which forces `.strict()` on object schemas, so
 * an undeclared field produces a MedusaError(INVALID_DATA) - the same error
 * the framework's error handler turns into a 400 response.
 */
async function runValidator(middleware: any, req: Record<string, any>) {
  let error: any;

  await middleware(req, {}, (err?: any) => {
    error = err;
  });

  return { req, error };
}

describe("AdminUpdatePaypalSettingsBody (PATCH /admin/paypal/settings)", () => {
  const validator = validateAndTransformBody(AdminUpdatePaypalSettingsBody);

  it("accepts an empty patch and keeps explicit nulls (clear to inherit)", async () => {
    const empty = await runValidator(validator, { body: {} });
    expect(empty.error).toBeUndefined();
    expect(empty.req.validatedBody).toEqual({});

    const patch = await runValidator(validator, {
      body: { clientId: "live-id", clientSecret: null, isSandbox: false },
    });
    expect(patch.error).toBeUndefined();
    expect(patch.req.validatedBody).toEqual({
      clientId: "live-id",
      clientSecret: null,
      isSandbox: false,
    });
  });

  it("accepts all nine editable fields", async () => {
    const { error, req } = await runValidator(validator, {
      body: {
        clientId: "id",
        clientSecret: "secret",
        isSandbox: true,
        webhookId: "wh",
        subscriptionWebhookId: "swh",
        includeShippingData: true,
        includeCustomerData: false,
        autoBillOutstanding: true,
        paymentFailureThreshold: 3,
      },
    });

    expect(error).toBeUndefined();
    expect(Object.keys(req.validatedBody)).toHaveLength(9);
  });

  it("rejects an undeclared field - the plural middlewares.ts is loaded", async () => {
    const { error, req } = await runValidator(validator, {
      body: { clientId: "id", nope: 1 },
    });

    expect(error).toBeInstanceOf(MedusaError);
    expect(error.type).toBe(MedusaError.Types.INVALID_DATA);
    expect(error.message).toMatch(/Unrecognized fields: 'nope'/);
    expect(req.validatedBody).toBeUndefined();
  });

  it("rejects wrong field types", async () => {
    const badBoolean = await runValidator(validator, {
      body: { isSandbox: "yes" },
    });
    expect(badBoolean.error).toBeInstanceOf(MedusaError);

    const badNumber = await runValidator(validator, {
      body: { paymentFailureThreshold: 1.5 },
    });
    expect(badNumber.error).toBeInstanceOf(MedusaError);
  });
});

describe("AdminTestPaypalSettingsBody (POST /admin/paypal/settings/verify)", () => {
  const validator = validateAndTransformBody(AdminTestPaypalSettingsBody);

  it("accepts drafts and an empty body", async () => {
    const empty = await runValidator(validator, { body: {} });
    expect(empty.error).toBeUndefined();

    const draft = await runValidator(validator, {
      body: { clientId: "id", clientSecret: "secret", isSandbox: true },
    });
    expect(draft.error).toBeUndefined();
    expect(draft.req.validatedBody).toEqual({
      clientId: "id",
      clientSecret: "secret",
      isSandbox: true,
    });
  });

  it("rejects fields outside the draft set", async () => {
    const { error } = await runValidator(validator, {
      body: { webhookId: "wh" },
    });

    expect(error).toBeInstanceOf(MedusaError);
    expect(error.message).toMatch(/Unrecognized fields: 'webhookId'/);
  });
});

describe("AdminListPaypalSettingsAuditQuery (GET /admin/paypal/settings/audit)", () => {
  const validator = validateAndTransformQuery(AdminListPaypalSettingsAuditQuery, {
    isList: true,
  });

  it("coerces the query-string limit to a number", async () => {
    const { error, req } = await runValidator(validator, {
      query: { limit: "20" },
    });

    expect(error).toBeUndefined();
    expect(req.validatedQuery).toEqual({ limit: 20 });
  });

  it("accepts a missing limit and rejects out-of-range or unknown keys", async () => {
    const missing = await runValidator(validator, { query: {} });
    expect(missing.error).toBeUndefined();

    for (const query of [{ limit: "0" }, { limit: "101" }, { nope: "1" }]) {
      const { error } = await runValidator(validator, { query });
      expect(error).toBeInstanceOf(MedusaError);
    }
  });
});

describe("resolveRequestOrigin", () => {
  it("prefers X-Forwarded-* and keeps the port", () => {
    expect(
      resolveRequestOrigin({
        protocol: "http",
        headers: {
          "x-forwarded-proto": "https, http",
          "x-forwarded-host": "shop.example.com:8443",
          host: "internal:9000",
        },
      })
    ).toBe("https://shop.example.com:8443");
  });

  it("falls back to the request protocol and Host header", () => {
    expect(
      resolveRequestOrigin({ protocol: "http", headers: { host: "localhost:9000" } })
    ).toBe("http://localhost:9000");
  });

  it("returns null without a host", () => {
    expect(resolveRequestOrigin({ headers: {} })).toBeNull();
  });
});

describe("resolveActorId", () => {
  it("reads the authenticated actor, including API key ids", () => {
    expect(resolveActorId({ auth_context: { actor_id: "user_1" } })).toBe(
      "user_1"
    );
    expect(
      resolveActorId({ auth_context: { actor_id: "apk_1", actor_type: "api-key" } })
    ).toBe("apk_1");
    expect(resolveActorId({})).toBeNull();
  });
});

describe("sanitizeCredentialError", () => {
  it("redacts the secret and the Basic auth token", () => {
    const secret = "super-secret-abcd";
    const basic = Buffer.from(`id-1:${secret}`).toString("base64");
    const message = `Failed to get access token: {"auth":"Basic ${basic}","secret":"${secret}"}`;

    const sanitized = sanitizeCredentialError(new Error(message), "id-1", secret);

    expect(sanitized).not.toContain(secret);
    expect(sanitized).not.toContain(basic);
    expect(sanitized).toContain("[redacted]");
  });
});

describe("shapePaypalSettingsResponse", () => {
  const sources = {
    clientId: "db",
    clientSecret: "db",
    isSandbox: "db",
    webhookId: "provider_options",
    subscriptionWebhookId: "none",
    includeShippingData: "none",
    includeCustomerData: "plugin_options",
    autoBillOutstanding: "none",
    paymentFailureThreshold: "none",
  } as const;

  const resolved = {
    config: {
      clientId: "client-1",
      clientSecret: "super-secret-1234",
      isSandbox: true,
      webhookId: "wh_1",
      subscriptionWebhookId: undefined,
      includeShippingData: false,
      includeCustomerData: true,
      autoBillOutstanding: undefined,
      paymentFailureThreshold: undefined,
    },
    version: 3,
    sources: sources as any,
    meta: {
      lastModifiedBy: "user_1",
      lastModifiedAt: "2026-09-29T08:00:00.000Z",
      lastVerifiedAt: "2026-09-29T09:00:00.000Z",
      lastVerifiedOk: true,
    },
  };

  it("never returns the raw secret, only hasSecret and its tail", () => {
    const body = shapePaypalSettingsResponse({
      resolved,
      origin: "https://shop.example.com",
      webhookProviderId: "paypal_paypal",
      reconcileCron: "0 3 * * *",
    });

    expect(JSON.stringify(body)).not.toContain("super-secret-1234");
    expect(body.settings.clientSecret).toEqual({
      hasSecret: true,
      secretTail: "1234",
      source: "db",
    });
    expect(body.settings.clientId).toEqual({ value: "client-1", source: "db" });
    expect(body.settings.webhookId).toEqual({
      value: "wh_1",
      source: "provider_options",
    });
    expect(body.settings.subscriptionWebhookId).toEqual({
      value: null,
      source: "none",
    });
    expect(body.environment).toBe("sandbox");
    expect(body.version).toBe(3);
    expect(body.lastModifiedBy).toBe("user_1");
    expect(body.integration).toEqual({
      paymentWebhookUrl:
        "https://shop.example.com/hooks/payment/paypal_paypal",
      subscriptionWebhookUrl:
        "https://shop.example.com/hooks/paypal/subscriptions",
      reconcileCron: "0 3 * * *",
    });
  });

  it("reports unconfigured without credentials and falls back to path-only URLs", () => {
    const body = shapePaypalSettingsResponse({
      resolved: {
        ...resolved,
        config: { ...resolved.config, clientId: undefined, clientSecret: undefined },
      },
      origin: null,
      webhookProviderId: "paypal",
      reconcileCron: "0 3 * * *",
    });

    expect(body.environment).toBe("unconfigured");
    expect(body.settings.clientSecret.hasSecret).toBe(false);
    expect(body.settings.clientSecret.secretTail).toBeNull();
    expect(body.integration.paymentWebhookUrl).toBe("/hooks/payment/paypal");
  });
});
