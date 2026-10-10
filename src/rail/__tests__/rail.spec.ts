import {
  createPaypalRail,
  PaypalApprovalPendingError,
  PaypalNotConfiguredError,
} from "../index";
import {
  PAYPAL_RAIL_KIND,
  toNativeDeclaration,
  toNativeSubscriptionRecord,
  toRailStatus,
} from "../records";
import { nativeSubscriptionChangedPayloads } from "./native-subscription-changed.fixture";

const RAIL_OPTIONS = {
  providerId: "pp_paypal_paypal",
  clientId: "test-client",
  clientSecret: "test-secret",
  isSandbox: true,
};

describe("toRailStatus", () => {
  it("maps PayPal's lifecycle states into the rail vocabulary", () => {
    expect(toRailStatus("ACTIVE")).toBe("active");
    expect(toRailStatus("SUSPENDED")).toBe("paused");
    expect(toRailStatus("CANCELLED")).toBe("cancelled");
    expect(toRailStatus("EXPIRED")).toBe("cancelled");
  });

  it("answers null (do not mirror) for an approval that has not completed", () => {
    expect(toRailStatus("APPROVAL_PENDING")).toBeNull();
  });

  it("answers null for a state it has never seen instead of inventing active", () => {
    expect(toRailStatus("SOMETHING_NEW")).toBeNull();
    expect(toRailStatus(null)).toBeNull();
  });
});

describe("toNativeSubscriptionRecord", () => {
  it("normalises a module row into the rail record, dates included", () => {
    const record = toNativeSubscriptionRecord({
      paypal_subscription_id: "I-1",
      paypal_plan_id: "P-1",
      status: "ACTIVE",
      customer_id: "cus_1",
      variant_id: "variant_1",
      interval_unit: "MONTH",
      interval_count: 3,
      next_billing_at: new Date("2026-11-06T00:00:00.000Z"),
      last_billing_at: "2026-10-06T00:00:00.000Z",
    });

    expect(record).toEqual({
      provider_subscription_id: "I-1",
      plan_id: "P-1",
      status: "active",
      customer_id: "cus_1",
      variant_id: "variant_1",
      interval_unit: "MONTH",
      interval_count: 3,
      next_billing_at: "2026-11-06T00:00:00.000Z",
      last_billing_at: "2026-10-06T00:00:00.000Z",
    });
  });

  it("keeps missing fields null rather than undefined", () => {
    const record = toNativeSubscriptionRecord({
      paypal_subscription_id: "I-1",
      status: "ACTIVE",
      interval_unit: "MONTH",
      interval_count: 1,
    });

    expect(record.plan_id).toBeNull();
    expect(record.customer_id).toBeNull();
    expect(record.variant_id).toBeNull();
    expect(record.next_billing_at).toBeNull();
    expect(record.last_billing_at).toBeNull();
  });
});

describe("toNativeDeclaration", () => {
  it("renders the merchant's declaration as labelled field rows", () => {
    const declaration = toNativeDeclaration({
      paypal_subscription: {
        interval_unit: "MONTH",
        interval_count: 3,
        trial_periods: [{ unit: "DAY", count: 14, price: 0 }],
        setup_fee: 4.5,
      },
    });

    expect(declaration?.fields).toEqual([
      { key: "interval", label: "Billing interval", value: "3 months" },
      { key: "trial_period", label: "Trial period", value: "14 days free" },
      { key: "setup_fee", label: "Setup fee (checkout currency)", value: "4.5" },
      { key: "product_type", label: "Product type", value: "SERVICE" },
    ]);
  });

  it("prices a paid trial and singularises a one-unit interval", () => {
    const declaration = toNativeDeclaration({
      paypal_subscription: {
        interval_unit: "MONTH",
        interval_count: 1,
        trial_periods: [{ unit: "MONTH", count: 1, price: 1.99 }],
      },
    });

    expect(declaration?.fields[0].value).toBe("1 month");
    expect(declaration?.fields[1].value).toBe("1 month at 1.99");
    expect(declaration?.fields[2].value).toBeNull();
  });

  it("answers null for a variant that is not a subscription, and for a broken one", () => {
    expect(toNativeDeclaration(null)).toBeNull();
    expect(toNativeDeclaration({})).toBeNull();
    // A malformed declaration must not blank the whole admin card.
    expect(
      toNativeDeclaration({ paypal_subscription: { interval_unit: "FORTNIGHT" } })
    ).toBeNull();
  });
});

describe("createPaypalRail", () => {
  it("builds the descriptor medusa-payment-methods consumes", () => {
    const rail = createPaypalRail(RAIL_OPTIONS);

    expect(rail.provider_id).toBe("pp_paypal_paypal");
    expect(rail.kind).toBe(PAYPAL_RAIL_KIND);
    expect(rail.display_name).toBe("PayPal");
    expect(typeof rail.binding.start).toBe("function");
    expect(typeof rail.binding.complete).toBe("function");
    expect(typeof rail.native?.listRecords).toBe("function");
    expect(typeof rail.native?.cancel).toBe("function");
    expect(rail.native?.readVariantDeclaration(null)).toBeNull();
  });

  it("refuses a credential set declared for the wrong environment", () => {
    expect(() =>
      createPaypalRail({
        ...RAIL_OPTIONS,
        isSandbox: false,
        credentialEnvironment: "sandbox",
      })
    ).toThrow();
  });

  it("builds without credentials and only fails at the first binding call (#01)", async () => {
    // A host that only ever uses the native rail never hands us credentials,
    // so the factory must not punish it at boot - the guard fires where the
    // credentials are actually spent.
    const rail = createPaypalRail({
      ...RAIL_OPTIONS,
      clientId: "",
      clientSecret: "   ",
    });

    await expect(
      rail.binding.start({
        customerId: "cus_1",
        returnUrl: "https://shop.test/return",
        cancelUrl: "https://shop.test/cancel",
      })
    ).rejects.toBeInstanceOf(PaypalNotConfiguredError);
  });

  it("classifies its own failures for the plugin's boundary", () => {
    const rail = createPaypalRail(RAIL_OPTIONS);

    expect(rail.binding.isPendingApproval?.(new PaypalApprovalPendingError("APPROVED"))).toBe(
      true
    );
    expect(rail.binding.isPendingApproval?.(new Error("boom"))).toBe(false);

    const used = Object.assign(new Error("already used"), {
      name: "ApprovalAlreadyUsedError",
    });
    expect(rail.binding.isAlreadyCompleted?.(used)).toBe(true);
    expect(rail.binding.isAlreadyCompleted?.(new Error("boom"))).toBe(false);
  });

  it("claims only the credential-environment mismatch, and keeps its 500", () => {
    const rail = createPaypalRail(RAIL_OPTIONS);
    const mismatch = Object.assign(new Error("sandbox credentials vs live"), {
      name: "PaypalCredentialEnvironmentMismatchError",
    });

    expect(rail.mapError?.(mismatch)).toEqual({
      status: 500,
      type: "unexpected_state",
    });
    expect(rail.mapError?.(new Error("some other failure"))).toBeNull();
  });

  it("claims missing credentials as an operator fault, not a PayPal outage (#01)", () => {
    const rail = createPaypalRail(RAIL_OPTIONS);

    expect(
      rail.mapError?.(new PaypalNotConfiguredError("PayPal is not configured."))
    ).toEqual({ status: 500, type: "unexpected_state" });

    // Recognised by name too, for a host holding a duplicate copy of the package.
    expect(
      rail.mapError?.(
        Object.assign(new Error("PayPal is not configured."), {
          name: "PaypalNotConfiguredError",
        })
      )
    ).toEqual({ status: 500, type: "unexpected_state" });
  });

  it("skips a cancel it cannot serve instead of throwing", async () => {
    const rail = createPaypalRail(RAIL_OPTIONS);
    const emptyContainer = {
      resolve: () => {
        throw new Error("not registered");
      },
    } as any;

    await expect(rail.native?.cancel(emptyContainer, "I-1")).resolves.toEqual({
      status: "skipped",
      reason: "capability_absent",
    });
    await expect(rail.native?.cancel(emptyContainer, "   ")).resolves.toEqual({
      status: "skipped",
      reason: "provider_row_missing",
    });
  });

  it("lists the module's rows and drops rows without a subscription id", async () => {
    const rail = createPaypalRail(RAIL_OPTIONS);
    const container = {
      resolve: () => ({
        listSubscriptions: async () => [
          {
            paypal_subscription_id: "I-1",
            status: "ACTIVE",
            interval_unit: "MONTH",
            interval_count: 1,
          },
          { paypal_subscription_id: "  ", status: "ACTIVE" },
        ],
      }),
    } as any;

    const records = await rail.native?.listRecords(container);

    expect(records).toHaveLength(1);
    expect(records?.[0]).toMatchObject({
      provider_subscription_id: "I-1",
      status: "active",
    });
  });

  it("cancels through the module and reports both ids", async () => {
    const rail = createPaypalRail(RAIL_OPTIONS);
    const calls: Array<[string, string]> = [];
    const container = {
      resolve: () => ({
        listSubscriptions: async () => [{ id: "sub_1", paypal_subscription_id: "I-1" }],
        requestLifecycleAction: async (id: string, action: string) => {
          calls.push([id, action]);
        },
      }),
    } as any;

    await expect(rail.native?.cancel(container, "I-1")).resolves.toEqual({
      status: "cancelled",
      provider_subscription_id: "I-1",
      provider_row_id: "sub_1",
    });
    expect(calls).toEqual([["sub_1", "cancel"]]);
  });

  it("reports an unknown subscription as skipped, and a failure as failed", async () => {
    const rail = createPaypalRail(RAIL_OPTIONS);

    const unknown = {
      resolve: () => ({
        listSubscriptions: async () => [],
        // The capability has to be there for the lookup to be reached at all:
        // a module without it answers `capability_absent` instead.
        requestLifecycleAction: async () => undefined,
      }),
    } as any;
    await expect(rail.native?.cancel(unknown, "I-nope")).resolves.toEqual({
      status: "skipped",
      reason: "provider_row_missing",
    });

    const failing = {
      resolve: () => ({
        listSubscriptions: async () => [{ id: "sub_1", paypal_subscription_id: "I-1" }],
        requestLifecycleAction: async () => {
          throw new Error("PayPal said no");
        },
      }),
    } as any;
    await expect(rail.native?.cancel(failing, "I-1")).resolves.toEqual({
      status: "failed",
      provider_subscription_id: "I-1",
      provider_row_id: "sub_1",
      error: "PayPal said no",
    });
  });
});

describe("the canonical fixture copy", () => {
  it("covers every transition the engine can publish", () => {
    const transitions = [
      ...new Set(
        Object.values(nativeSubscriptionChangedPayloads).map(
          (payload) => payload.transition
        )
      ),
    ].sort();

    expect(transitions).toEqual(["payment_failed", "payment_succeeded", "status"]);
  });

  it("uses the rail-neutral status vocabulary and this provider's kind", () => {
    for (const payload of Object.values(nativeSubscriptionChangedPayloads)) {
      expect(["active", "paused", "past_due", "cancelled", null]).toContain(
        payload.status
      );
      expect(payload.kind).toBe(PAYPAL_RAIL_KIND);
    }
  });
});
