import { MedusaError } from "@medusajs/framework/utils";
import { SubscriptionEngine } from "../engine";
import { resetPaypalFractionDigitsCache } from "../../lib/currency-digits";
import { parseSubscriptionMetadata } from "../metadata";
import { PAYPAL_RAIL_KIND } from "../../rail/records";
import { nativeSubscriptionChangedPayloads } from "../../rail/__tests__/native-subscription-changed.fixture";
import {
  FakeSubscriptionModule,
  makeEventBus,
  makeFirstOrder,
  makeOrderModule,
  makePaymentModule,
  makeProductModule,
  makeQuery,
  makeRailSink,
  makeRow,
  makeVariant,
  makeWorkflowEngine,
} from "./fakes";

const loggerStub = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    environment: "sandbox",
    createBillingProduct: jest.fn().mockResolvedValue({ id: "prod_P1" }),
    createBillingPlan: jest.fn().mockResolvedValue({ id: "plan_P1" }),
    createSubscription: jest.fn().mockResolvedValue({
      id: "I-NEW",
      status: "APPROVAL_PENDING",
      links: [{ rel: "approve", href: "https://www.paypal.com/approve" }],
    }),
    getSubscription: jest.fn().mockResolvedValue({ id: "I-ABC123", status: "ACTIVE" }),
    reviseSubscription: jest.fn().mockResolvedValue({ id: "I-ABC123", status: "ACTIVE" }),
    subscriptionAction: jest.fn().mockResolvedValue(undefined),
    listSubscriptionTransactions: jest.fn().mockResolvedValue([]),
    getSale: jest.fn().mockResolvedValue({ id: "sale_1", status: "COMPLETED" }),
    refundSale: jest.fn().mockResolvedValue({ id: "ref_1", status: "COMPLETED" }),
    getCapture: jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("not found"), { paypalStatus: 404 })),
    refundCapture: jest.fn().mockResolvedValue({ id: "ref_c1", status: "COMPLETED" }),
    ...overrides,
  } as any;
}

type Harness = {
  module: FakeSubscriptionModule;
  eventBus: ReturnType<typeof makeEventBus>;
  rail: ReturnType<typeof makeRailSink>;
  client: any;
  productModule: ReturnType<typeof makeProductModule>;
  orderModule: ReturnType<typeof makeOrderModule>;
  paymentModule: ReturnType<typeof makePaymentModule>;
  workflowEngine: ReturnType<typeof makeWorkflowEngine>;
  query: ReturnType<typeof makeQuery>;
  engine: SubscriptionEngine;
};

function makeHarness(opts: {
  variants?: any[];
  productTitles?: Record<string, string>;
  firstOrder?: any;
  client?: any;
  currencies?: Array<{ code: string; decimal_digits: number }>;
} = {}): Harness {
  const subscriptionModule = new FakeSubscriptionModule();
  const eventBus = makeEventBus();
  const rail = makeRailSink();
  const client = opts.client ?? makeClient();
  const variants = opts.variants ?? [makeVariant()];
  const productModule = makeProductModule(variants, opts.productTitles ?? {});
  const firstOrder = "firstOrder" in opts ? opts.firstOrder : makeFirstOrder();
  const orderModule = makeOrderModule(firstOrder);
  const paymentModule = makePaymentModule();
  const workflowEngine = makeWorkflowEngine();
  const query = makeQuery(firstOrder, opts.currencies, variants);

  const engine = new SubscriptionEngine({
    client,
    logger: loggerStub as never,
    eventBus: eventBus as any,
    subscriptionModule: subscriptionModule as any,
    productModule,
    orderModule,
    paymentModule,
    workflowEngine,
    query,
    // The host-wired rail sink: the engine publishes every transition through
    // it and knows no event name of its own.
    options: { onNativeSubscriptionChanged: rail.hook },
  });

  return {
    module: subscriptionModule,
    eventBus,
    rail,
    client,
    productModule,
    orderModule,
    paymentModule,
    workflowEngine,
    query,
    engine,
  };
}

describe("subscription metadata parsing", () => {
  it("returns null for variants without the key", () => {
    expect(parseSubscriptionMetadata({})).toBeNull();
    expect(parseSubscriptionMetadata(null)).toBeNull();
  });

  it("parses a valid declaration with defaults", () => {
    const config = parseSubscriptionMetadata({
      paypal_subscription: { interval_unit: "MONTH", interval_count: 1 },
    });

    expect(config).toMatchObject({
      interval_unit: "MONTH",
      interval_count: 1,
      product_type: "SERVICE",
    });
  });

  it("accepts JSON-string metadata", () => {
    const config = parseSubscriptionMetadata({
      paypal_subscription: '{"interval_unit":"YEAR","interval_count":1,"setup_fee":5}',
    });

    expect(config?.setup_fee).toBe(5);
  });

  it("throws a clear error for malformed declarations", () => {
    expect(() =>
      parseSubscriptionMetadata({ paypal_subscription: { interval_unit: "CENTURY" } })
    ).toThrow(MedusaError);
    expect(() =>
      parseSubscriptionMetadata({ paypal_subscription: "{not json" })
    ).toThrow(/not valid JSON/);
  });
});

describe("plan management", () => {
  beforeEach(() => resetPaypalFractionDigitsCache());

  it("creates product + plan on first use and caches by config hash", async () => {
    const h = makeHarness();

    const variant = makeVariant();
    const first = await h.engine.ensurePlan({
      variant,
      config: { interval_unit: "MONTH", interval_count: 1, product_type: "SERVICE" },
      currencyCode: "usd",
      amount: 19.99,
    });

    expect(h.client.createBillingProduct).toHaveBeenCalledTimes(1);
    expect(h.client.createBillingPlan).toHaveBeenCalledTimes(1);
    expect(first.planRow.paypal_plan_id).toBe("plan_P1");
    // Regular cycle carries the locked variant price in major units.
    const regular = h.client.createBillingPlan.mock.calls[0][0].billing_cycles.find(
      (cycle: any) => cycle.tenure_type === "REGULAR"
    );
    expect(regular.pricing_scheme.fixed_price).toEqual({ value: "19.99", currency_code: "usd" });

    const second = await h.engine.ensurePlan({
      variant,
      config: { interval_unit: "MONTH", interval_count: 1, product_type: "SERVICE" },
      currencyCode: "usd",
      amount: 19.99,
    });

    expect(second.planRow.paypal_plan_id).toBe("plan_P1");
    expect(h.client.createBillingPlan).toHaveBeenCalledTimes(1);
  });

  it("mints a new plan version when the price changes", async () => {
    const h = makeHarness();

    await h.engine.ensurePlan({
      variant: makeVariant(),
      config: { interval_unit: "MONTH", interval_count: 1, product_type: "SERVICE" },
      currencyCode: "usd",
      amount: 19.99,
    });

    await h.engine.ensurePlan({
      variant: makeVariant({ prices: [{ currency_code: "usd", amount: 24.99 }] }),
      config: { interval_unit: "MONTH", interval_count: 1, product_type: "SERVICE" },
      currencyCode: "usd",
      amount: 24.99,
    });

    expect(h.client.createBillingPlan).toHaveBeenCalledTimes(2);
    expect(h.client.createBillingProduct).toHaveBeenCalledTimes(1); // product reused
    expect(h.module.plans).toHaveLength(2);
  });

  it("emits trial + setup fee cycles when declared", async () => {
    const h = makeHarness();

    await h.engine.ensurePlan({
      variant: makeVariant(),
      config: {
        interval_unit: "MONTH",
        interval_count: 1,
        trial_periods: [{ unit: "DAY", count: 7, price: 0 }],
        setup_fee: 1,
        product_type: "SERVICE",
      },
      currencyCode: "usd",
      amount: 19.99,
    });

    const cycles = h.client.createBillingPlan.mock.calls[0][0].billing_cycles;
    expect(cycles).toHaveLength(2);
    expect(cycles[0]).toMatchObject({
      tenure_type: "TRIAL",
      total_cycles: 1,
      pricing_scheme: { fixed_price: { value: "0.00" } },
    });
    expect(cycles[0].billing_preferences.setup_fee).toEqual({
      value: "1.00",
      currency_code: "usd",
    });
  });

  it("formats plan amounts with the currency's own fraction digits", async () => {
    const h = makeHarness({ currencies: [{ code: "jpy", decimal_digits: 0 }] });

    await h.engine.ensurePlan({
      variant: makeVariant({ prices: [{ currency_code: "jpy", amount: 1000 }] }),
      config: { interval_unit: "MONTH", interval_count: 1, product_type: "SERVICE" },
      currencyCode: "jpy",
      amount: 1000,
    });

    const regular = h.client.createBillingPlan.mock.calls[0][0].billing_cycles.find(
      (cycle: any) => cycle.tenure_type === "REGULAR"
    );
    // Zero-decimal currencies are rejected by PayPal with a ".00" suffix.
    expect(regular.pricing_scheme.fixed_price).toEqual({
      value: "1000",
      currency_code: "jpy",
    });
  });
});

describe("checkout detection", () => {
  it("returns false when no items carry subscription metadata", async () => {
    const h = makeHarness({
      variants: [makeVariant({ metadata: {} })],
    });

    const detection = await h.engine.detectSubscriptionSession([
      { variant_id: "variant_1", quantity: 1 },
    ]);

    expect(detection.subscription).toBe(false);
  });

  it("rejects mixing subscription and regular items", async () => {
    const h = makeHarness({
      variants: [makeVariant(), makeVariant({ id: "variant_2", metadata: {} })],
    });

    await expect(
      h.engine.detectSubscriptionSession([
        { variant_id: "variant_1", quantity: 1 },
        { variant_id: "variant_2", quantity: 1 },
      ])
    ).rejects.toThrow(/separately/);
  });

  it("rejects multiple subscription variants and quantity > 1", async () => {
    const h = makeHarness({
      variants: [makeVariant(), makeVariant({ id: "variant_2" })],
    });

    await expect(
      h.engine.detectSubscriptionSession([
        { variant_id: "variant_1", quantity: 1 },
        { variant_id: "variant_2", quantity: 1 },
      ])
    ).rejects.toThrow(/one subscription per order/);

    await expect(
      h.engine.detectSubscriptionSession([{ variant_id: "variant_1", quantity: 2 }])
    ).rejects.toThrow(/quantity of 1/);
  });

  it("accepts a single subscription item", async () => {
    const h = makeHarness();

    const detection = await h.engine.detectSubscriptionSession([
      { variant_id: "variant_1", quantity: 1 },
    ]);

    expect(detection.subscription).toBe(true);
    expect(detection.variant?.id).toBe("variant_1");
  });
});

describe("duplicate-subscription guard (R5)", () => {
  const monthly = makeVariant({ product_id: "prod_1" });
  const yearly = makeVariant({
    id: "variant_2",
    title: "Yearly Club",
    product_id: "prod_1",
    metadata: { paypal_subscription: { interval_unit: "YEAR", interval_count: 1 } },
    prices: [{ currency_code: "usd", amount: 199 }],
  });
  const otherProduct = makeVariant({
    id: "variant_3",
    title: "Poster Club",
    product_id: "prod_2",
  });

  it("refuses a second live subscription for the same product and names it", async () => {
    const h = makeHarness({
      variants: [monthly, yearly],
      productTitles: { prod_1: "Monthly Club" },
    });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1" })
    );

    await expect(
      h.engine.assertNoConflictingSubscription({
        customerId: "cus_1",
        variantId: "variant_2",
      })
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      code: "SUBSCRIPTION_ALREADY_ACTIVE",
      message: expect.stringContaining("Monthly Club"),
    });
  });

  it("blocks a paused subscription too - it still owns the product", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "SUSPENDED", variant_id: "variant_1" })
    );

    await expect(
      h.engine.assertNoConflictingSubscription({
        customerId: "cus_1",
        variantId: "variant_2",
      })
    ).rejects.toMatchObject({ code: "SUBSCRIPTION_ALREADY_ACTIVE" });
  });

  it("lets a different product through", async () => {
    const h = makeHarness({ variants: [monthly, yearly, otherProduct] });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1" })
    );

    await expect(
      h.engine.assertNoConflictingSubscription({
        customerId: "cus_1",
        variantId: "variant_3",
      })
    ).resolves.toBeUndefined();
  });

  it("does not block on an abandoned approval or on history", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "APPROVAL_PENDING", variant_id: "variant_1" })
    );

    await expect(
      h.engine.assertNoConflictingSubscription({
        customerId: "cus_1",
        variantId: "variant_2",
      })
    ).resolves.toBeUndefined();

    await h.module.updatePaypalSubscriptions({ id: "sub_1", status: "CANCELLED" });

    await expect(
      h.engine.assertNoConflictingSubscription({
        customerId: "cus_1",
        variantId: "variant_2",
      })
    ).resolves.toBeUndefined();
  });

  it("scopes the check to the buyer - another customer's subscription is not theirs", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", customer_id: "cus_other" })
    );

    await expect(
      h.engine.assertNoConflictingSubscription({
        customerId: "cus_2",
        variantId: "variant_2",
      })
    ).resolves.toBeUndefined();
  });

  it("leaves a guest checkout alone (no customer to key on)", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", customer_id: null })
    );

    await expect(
      h.engine.assertNoConflictingSubscription({
        customerId: null,
        variantId: "variant_2",
      })
    ).resolves.toBeUndefined();
  });
});

describe("session initiation", () => {
  it("creates the PayPal subscription with custom_id = session id and records the row", async () => {
    const h = makeHarness();

    const result = await h.engine.initiateSubscriptionSession({
      sessionId: "sess_1",
      variantId: "variant_1",
      currencyCode: "usd",
      amount: 19.99,
      customerId: "cus_1",
    });

    expect(h.client.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: "plan_P1", custom_id: "sess_1" })
    );
    expect(result.row.status).toBe("APPROVAL_PENDING");
    expect(result.row.payment_session_id).toBe("sess_1");
    expect(result.row.locked_amount).toBe(19.99);
    expect(result.approveLink).toBe("https://www.paypal.com/approve");
  });

  it("falls back to the payer-action link when PayPal omits approve", async () => {
    const payerActionUrl =
      "https://www.paypal.com/payer-action?token=I-NEW";
    const h = makeHarness({
      client: makeClient({
        createSubscription: jest.fn().mockResolvedValue({
          id: "I-NEW",
          status: "APPROVAL_PENDING",
          links: [
            {
              rel: "self",
              href: "https://api-m.paypal.com/v1/billing/subscriptions/I-NEW",
            },
            { rel: "payer-action", href: payerActionUrl },
          ],
        }),
      }),
    });

    const result = await h.engine.initiateSubscriptionSession({
      sessionId: "sess_1",
      variantId: "variant_1",
      currencyCode: "usd",
      amount: 19.99,
      customerId: "cus_1",
    });

    expect(result.approveLink).toBe(payerActionUrl);
    expect((result.row.metadata as any)?.approve_link).toBe(payerActionUrl);
  });

  it("is idempotent per session (Buttons route cannot double-create)", async () => {
    const h = makeHarness();

    const first = await h.engine.initiateSubscriptionSession({
      sessionId: "sess_1",
      variantId: "variant_1",
      currencyCode: "usd",
      amount: 19.99,
    });
    const second = await h.engine.initiateSubscriptionSession({
      sessionId: "sess_1",
      variantId: "variant_1",
      currencyCode: "usd",
      amount: 19.99,
    });

    expect(h.client.createSubscription).toHaveBeenCalledTimes(1);
    expect(second.paypalSubscriptionId).toBe(first.paypalSubscriptionId);
  });
});

describe("authorization", () => {
  it("authorizes an ACTIVE subscription without PayPal calls", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    const result = await h.engine.authorizeSubscriptionSession({
      sessionData: { paypal_subscription_id: "I-ABC123" },
    });

    expect(result.status).toBe("authorized");
    expect(h.client.getSubscription).not.toHaveBeenCalled();
  });

  it("re-queries PayPal once when the local row is not active yet", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "APPROVAL_PENDING" }));

    const result = await h.engine.authorizeSubscriptionSession({
      sessionData: { paypal_subscription_id: "I-ABC123" },
    });

    expect(h.client.getSubscription).toHaveBeenCalledWith("I-ABC123");
    expect(result.status).toBe("authorized");
    expect(h.module.subscriptions[0].status).toBe("ACTIVE");
  });

  it("stays pending while the buyer has not approved", async () => {
    const h = makeHarness({
      client: makeClient({
        getSubscription: jest.fn().mockResolvedValue({ id: "I-ABC123", status: "APPROVAL_PENDING" }),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ status: "APPROVAL_PENDING" }));

    const result = await h.engine.authorizeSubscriptionSession({
      sessionData: { paypal_subscription_id: "I-ABC123" },
    });

    expect(result.status).toBe("pending");
  });

  it("records the renewal date PayPal reports when it activates the session", async () => {
    const h = makeHarness({
      client: makeClient({
        getSubscription: jest.fn().mockResolvedValue({
          id: "I-ABC123",
          status: "ACTIVE",
          billing_info: { next_billing_time: "2026-11-10T00:00:00Z" },
        }),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ status: "APPROVAL_PENDING" }));

    const result = await h.engine.authorizeSubscriptionSession({
      sessionData: { paypal_subscription_id: "I-ABC123" },
    });

    expect(result.status).toBe("authorized");
    expect(h.module.subscriptions[0].next_billing_at).toEqual(
      new Date("2026-11-10T00:00:00Z")
    );
    // Authorize stays silent on the rail: activation is published by the
    // ACTIVATED webhook, this path only makes sure the row is complete by then.
    expect(h.rail.payloads).toHaveLength(0);
  });

  it("warns instead of inventing a renewal date when PayPal reports none", async () => {
    const h = makeHarness({
      client: makeClient({
        getSubscription: jest
          .fn()
          .mockResolvedValue({ id: "I-ABC123", status: "ACTIVE" }),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ status: "APPROVAL_PENDING" }));
    loggerStub.warn.mockClear();

    const result = await h.engine.authorizeSubscriptionSession({
      sessionData: { paypal_subscription_id: "I-ABC123" },
    });

    expect(result.status).toBe("authorized");
    expect(h.module.subscriptions[0].next_billing_at).toBeNull();
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("no next billing time")
    );
  });
});

describe("webhook: BILLING.SUBSCRIPTION.ACTIVATED", () => {
  it("flips APPROVAL_PENDING to ACTIVE, emits the event, and creates no order", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "APPROVAL_PENDING" }));

    const result = await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.ACTIVATED", {
      id: "I-ABC123",
    });

    expect(result).toEqual({ action: "not_supported" });
    expect(h.module.subscriptions[0].status).toBe("ACTIVE");
    expect(h.rail.payloads).toEqual([
      expect.objectContaining({ status: "active", transition: "status" }),
    ]);
    expect(h.orderModule.createOrders).not.toHaveBeenCalled();
  });

  it("emits resumed (not activated) when a suspended subscription reactivates", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "SUSPENDED" }));

    await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-ABC123" });

    expect(h.rail.payloads[0]).toMatchObject({ status: "active", transition: "status" });
  });

  it("carries the renewal date off the webhook itself, with no PayPal call", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "APPROVAL_PENDING" }));

    await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.ACTIVATED", {
      id: "I-ABC123",
      billing_info: { next_billing_time: "2026-11-10T00:00:00Z" },
    });

    expect(h.client.getSubscription).not.toHaveBeenCalled();
    expect(h.module.subscriptions[0].next_billing_at).toEqual(
      new Date("2026-11-10T00:00:00Z")
    );
    expect(h.rail.payloads.at(-1)).toMatchObject({
      transition: "status",
      next_billing_at: "2026-11-10T00:00:00.000Z",
    });
  });

  it("ignores unknown subscriptions", async () => {
    const h = makeHarness();

    const result = await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.CANCELLED", {
      id: "I-UNKNOWN",
    });

    expect(result).toEqual({ action: "not_supported" });
    expect(h.rail.payloads).toHaveLength(0);
  });

  it("is idempotent on duplicate state events", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "CANCELLED" }));

    await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.CANCELLED", { id: "I-ABC123" });

    expect(h.rail.payloads).toHaveLength(0);
  });
});

describe("webhook: BILLING.SUBSCRIPTION.RE-ACTIVATED (resume)", () => {
  it("flips a SUSPENDED row back to ACTIVE and carries the renewal date", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "SUSPENDED" }));

    const result = await h.engine.handleWebhookEvent(
      "BILLING.SUBSCRIPTION.RE-ACTIVATED",
      { id: "I-ABC123", billing_info: { next_billing_time: "2026-11-10T00:00:00Z" } }
    );

    expect(result).toEqual({ action: "not_supported" });
    expect(h.module.subscriptions[0].status).toBe("ACTIVE");
    expect(h.module.subscriptions[0].next_billing_at).toEqual(
      new Date("2026-11-10T00:00:00Z")
    );
    expect(h.rail.payloads).toEqual([
      expect.objectContaining({ status: "active", transition: "status" }),
    ]);
  });

  it("is a no-op when the row is already ACTIVE", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.RE-ACTIVATED", {
      id: "I-ABC123",
    });

    expect(h.rail.payloads).toHaveLength(0);
  });

  it("ignores unknown subscriptions", async () => {
    const h = makeHarness();

    const result = await h.engine.handleWebhookEvent(
      "BILLING.SUBSCRIPTION.RE-ACTIVATED",
      { id: "I-UNKNOWN" }
    );

    expect(result).toEqual({ action: "not_supported" });
    expect(h.rail.payloads).toHaveLength(0);
  });
});

describe("webhook: BILLING.SUBSCRIPTION.UPDATED (consented plan switch)", () => {
  const monthly = makeVariant({ product_id: "prod_1" });
  const yearly = makeVariant({
    id: "variant_2",
    title: "Yearly Club",
    product_id: "prod_1",
    metadata: { paypal_subscription: { interval_unit: "YEAR", interval_count: 1 } },
    prices: [{ currency_code: "usd", amount: 199 }],
  });

  const updatedEvent = (planId: string) => ({
    id: "I-ABC123",
    status: "ACTIVE",
    plan_id: planId,
    billing_info: { next_billing_time: "2026-11-10T10:00:00Z" },
  });

  it("lands the switch the buyer approved on PayPal's page", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1", paypal_plan_id: "plan_1" })
    );
    await h.module.createPaypalPlans({
      variant_id: "variant_2",
      currency_code: "usd",
      paypal_plan_id: "plan_year",
      config_hash: "hash_year",
    });

    const result = await h.engine.handleWebhookEvent(
      "BILLING.SUBSCRIPTION.UPDATED",
      updatedEvent("plan_year")
    );

    expect(result).toEqual({ action: "not_supported" });
    expect(h.module.subscriptions[0]).toMatchObject({
      variant_id: "variant_2",
      paypal_plan_id: "plan_year",
      locked_amount: 199,
      interval_unit: "YEAR",
      interval_count: 1,
    });
    // No extra PayPal call: the webhook carries the renewal date.
    expect(h.client.getSubscription).not.toHaveBeenCalled();
    expect(h.rail.payloads.at(-1)).toMatchObject({
      transition: "status",
      status: "active",
      variant_id: "variant_2",
      plan_id: "plan_year",
      interval_unit: "YEAR",
      interval_count: 1,
      next_billing_at: "2026-11-10T10:00:00.000Z",
    });
  });

  it("keeps the local plan when PayPal reports a plan this plugin does not know", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1", paypal_plan_id: "plan_1" })
    );

    await h.engine.handleWebhookEvent(
      "BILLING.SUBSCRIPTION.UPDATED",
      updatedEvent("plan_foreign")
    );

    expect(h.module.subscriptions[0]).toMatchObject({
      variant_id: "variant_1",
      paypal_plan_id: "plan_1",
    });
    expect(h.rail.payloads).toHaveLength(0);
    expect(loggerStub.warn).toHaveBeenCalledWith(
      expect.stringContaining("which this plugin does not know")
    );
  });

  it("refreshes only the renewal date when the plan is unchanged", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1", paypal_plan_id: "plan_1" })
    );

    await h.engine.handleWebhookEvent(
      "BILLING.SUBSCRIPTION.UPDATED",
      updatedEvent("plan_1")
    );

    expect(h.module.subscriptions[0].next_billing_at).toEqual(
      new Date("2026-11-10T10:00:00Z")
    );
    expect(h.module.subscriptions[0].variant_id).toBe("variant_1");
    expect(h.rail.payloads).toHaveLength(0);
  });

  it("ignores unknown subscriptions", async () => {
    const h = makeHarness();

    const result = await h.engine.handleWebhookEvent(
      "BILLING.SUBSCRIPTION.UPDATED",
      updatedEvent("plan_year")
    );

    expect(result).toEqual({ action: "not_supported" });
    expect(h.rail.payloads).toHaveLength(0);
  });
});

describe("webhook: first-period PAYMENT.SALE.COMPLETED", () => {
  it("returns the standard captured action and records the first sale id", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    const result = await h.engine.handleWebhookEvent("PAYMENT.SALE.COMPLETED", {
      id: "sale_1",
      billing_agreement_id: "I-ABC123",
      amount: { value: "1.00", currency_code: "USD" },
      time: "2026-09-19T00:00:00Z",
    });

    expect(result).toEqual({
      action: "captured",
      data: { session_id: "sess_1", amount: 1 },
    });
    expect(h.module.subscriptions[0].first_sale_id).toBe("sale_1");
    expect(h.orderModule.createOrders).not.toHaveBeenCalled(); // cart completion owns the first order
    expect(h.rail.payloads).toEqual([
      expect.objectContaining({ status: "active", transition: "payment_succeeded" }),
    ]);
  });

  it("is idempotent for duplicate sale deliveries", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    const payload = { id: "sale_1", billing_agreement_id: "I-ABC123", amount: { value: "1.00" } };

    await h.engine.handleWebhookEvent("PAYMENT.SALE.COMPLETED", payload);
    const second = await h.engine.handleWebhookEvent("PAYMENT.SALE.COMPLETED", payload);

    expect(second).toEqual({ action: "not_supported" });
    // One delivery records the sale, the duplicate is a no-op — and only the
    // recording one publishes.
    expect(h.rail.payloads).toHaveLength(1);
  });
});

describe("renewal orders", () => {
  async function harnessWithFirstSale() {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(
      makeRow({
        status: "ACTIVE",
        first_sale_id: "sale_1",
        sales: [
          { sale_id: "sale_1", amount: 1, currency_code: "usd", billed_at: "2026-09-19T00:00:00Z" },
        ],
      })
    );
    return h;
  }

  it("clones first-order items at locked prices and records the sale anchor", async () => {
    const h = await harnessWithFirstSale();

    const result = await h.engine.handleWebhookEvent("PAYMENT.SALE.COMPLETED", {
      id: "sale_2",
      billing_agreement_id: "I-ABC123",
      amount: { value: "19.99", currency_code: "USD" },
      time: "2026-10-19T00:00:00Z",
    });

    expect(result).toEqual({ action: "not_supported" });

    const orderInput = h.orderModule.createOrders.mock.calls[0][0][0];
    expect(orderInput.customer_id).toBe("cus_1");
    expect(orderInput.items[0]).toMatchObject({ title: "Monthly Club", unit_price: 19.99 });
    expect(orderInput.metadata).toMatchObject({
      paypal_subscription_id: "I-ABC123",
      paypal_sale_id: "sale_2",
      paypal_renewal: true,
    });
    expect(h.paymentModule.createPaymentSession).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        data: expect.objectContaining({ paypal_sale_id: "sale_2", subscription_renewal: true }),
      })
    );
    expect(h.paymentModule.capturePayment).toHaveBeenCalled();

    expect(h.module.subscriptions[0].sales).toEqual([
      expect.objectContaining({ sale_id: "sale_1" }),
      expect.objectContaining({ sale_id: "sale_2", order_id: "order_renewal_1" }),
    ]);
    expect(h.rail.payloads[0]).toMatchObject({
      provider_subscription_id: "I-ABC123",
      status: "active",
      transition: "payment_succeeded",
      // The renewal's own charge time travels with the payload: the row's
      // status was already ACTIVE, so this timestamp is the only thing that
      // tells a consumer a charge happened at all.
      last_billing_at: expect.any(String),
    });
  });

  it("does not create a second order for a duplicate renewal event", async () => {
    const h = await harnessWithFirstSale();

    const payload = { id: "sale_2", billing_agreement_id: "I-ABC123", amount: { value: "19.99" } };
    await h.engine.handleWebhookEvent("PAYMENT.SALE.COMPLETED", payload);
    await h.engine.handleWebhookEvent("PAYMENT.SALE.COMPLETED", payload);

    expect(h.orderModule.createOrders).toHaveBeenCalledTimes(1);
  });
});

describe("refund sync (PayPal -> Medusa)", () => {
  it("records the refund and creates a Medusa refund for fully refunded sales", async () => {
    const h = makeHarness({
      client: makeClient({
        getSale: jest.fn().mockResolvedValue({ id: "sale_1", status: "REFUNDED" }),
      }),
      firstOrder: makeFirstOrder({ payment_collection_id: "col_first" }),
    });
    await h.module.createPaypalSubscriptions(
      makeRow({
        first_sale_id: "sale_1",
        sales: [{ sale_id: "sale_1", amount: 19.99, currency_code: "usd" }],
      })
    );

    await h.engine.handleWebhookEvent("PAYMENT.SALE.REFUNDED", {
      id: "ref_1",
      sale_id: "sale_1",
      billing_agreement_id: "I-ABC123",
      amount: { total: "19.99", currency: "USD" },
    });

    expect(h.paymentModule.refundPayment).toHaveBeenCalledWith({
      payment_id: "pay_first",
      amount: 19.99,
    });
    expect(h.module.subscriptions[0].refunds).toEqual([
      expect.objectContaining({ refund_id: "ref_1", sale_id: "sale_1" }),
    ]);
  });

  it("does not touch PayPal again when syncing (no double refund)", async () => {
    const h = makeHarness({
      client: makeClient({
        getSale: jest.fn().mockResolvedValue({ id: "sale_1", status: "REFUNDED" }),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ first_sale_id: "sale_1" }));

    await h.engine.handleWebhookEvent("PAYMENT.SALE.REVERSED", {
      id: "ref_1",
      sale_id: "sale_1",
      billing_agreement_id: "I-ABC123",
      amount: { total: "19.99" },
    });

    expect(h.client.refundSale).not.toHaveBeenCalled();
  });

  it("is idempotent for duplicate refund events", async () => {
    const h = makeHarness({
      client: makeClient({
        getSale: jest.fn().mockResolvedValue({ id: "sale_1", status: "REFUNDED" }),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ first_sale_id: "sale_1" }));

    const payload = { id: "ref_1", sale_id: "sale_1", billing_agreement_id: "I-ABC123", amount: { total: "19.99" } };
    await h.engine.handleWebhookEvent("PAYMENT.SALE.REFUNDED", payload);
    await h.engine.handleWebhookEvent("PAYMENT.SALE.REFUNDED", payload);

    expect(h.paymentModule.refundPayment).toHaveBeenCalledTimes(1);
  });
});

describe("refund (Medusa -> PayPal)", () => {
  it("refunds the recorded sale and skips when PayPal already refunded it", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ first_sale_id: "sale_1" }));

    const result = await h.engine.refundSubscriptionPayment(
      { paypal_subscription_id: "I-ABC123", is_subscription: true, currency_code: "usd" },
      19.99
    );

    expect(h.client.refundSale).toHaveBeenCalledWith(
      "sale_1",
      { value: "19.99", currency_code: "usd" },
      undefined
    );
    expect(result.saleId).toBe("sale_1");

    const refunded = makeHarness({
      client: makeClient({
        getSale: jest.fn().mockResolvedValue({ id: "sale_1", status: "REFUNDED" }),
      }),
    });
    await refunded.module.createPaypalSubscriptions(makeRow({ first_sale_id: "sale_1" }));

    await refunded.engine.refundSubscriptionPayment(
      { paypal_subscription_id: "I-ABC123", is_subscription: true },
      19.99
    );

    expect(refunded.client.refundSale).not.toHaveBeenCalled();
  });

  it("syncs a capture-rail panel refund through the session reference", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(
      makeRow({
        first_sale_id: "capt_1",
        sales: [{ sale_id: "capt_1", amount: 1, currency_code: "USD" }],
      })
    );

    await h.engine.syncCaptureRefundFromPaypal({
      id: "refund_1",
      status: "COMPLETED",
      amount: { value: "1.00", currency_code: "USD" },
      custom: "sess_1",
    });

    expect(h.paymentModule.refundPayment).toHaveBeenCalledWith({
      payment_id: "pay_first",
      amount: 1,
    });
    expect(h.module.subscriptions[0].refunds).toEqual([
      expect.objectContaining({ refund_id: "refund_1", order_id: "order_first" }),
    ]);
  });

  it("is idempotent for duplicate capture refund events", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(
      makeRow({
        first_sale_id: "capt_1",
        sales: [{ sale_id: "capt_1", amount: 1, currency_code: "USD" }],
      })
    );

    const resource = {
      id: "refund_1",
      amount: { value: "1.00", currency_code: "USD" },
      custom: "sess_1",
    };
    await h.engine.syncCaptureRefundFromPaypal(resource);
    await h.engine.syncCaptureRefundFromPaypal(resource);

    expect(h.paymentModule.refundPayment).toHaveBeenCalledTimes(1);
  });

  it("accepts the webhook resource shape (custom_id field)", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(
      makeRow({
        first_sale_id: "capt_1",
        sales: [{ sale_id: "capt_1", amount: 1, currency_code: "USD" }],
      })
    );

    await h.engine.syncCaptureRefundFromPaypal({
      id: "refund_1",
      status: "COMPLETED",
      amount: { currency_code: "USD", value: "1.00" },
      custom_id: "sess_1",
    });

    expect(h.paymentModule.refundPayment).toHaveBeenCalledWith({
      payment_id: "pay_first",
      amount: 1,
    });
    expect(h.module.subscriptions[0].refunds).toHaveLength(1);
  });

  it("ignores capture refunds without a session reference", async () => {
    const h = makeHarness();
    await h.engine.syncCaptureRefundFromPaypal({
      id: "refund_x",
      amount: { value: "1.00", currency_code: "USD" },
    });

    expect(h.paymentModule.refundPayment).not.toHaveBeenCalled();
  });

  it("throws a clear error when no sale exists (free trial not yet billed)", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow());

    await expect(
      h.engine.refundSubscriptionPayment({ paypal_subscription_id: "I-ABC123", is_subscription: true }, 1)
    ).rejects.toThrow(/free-trial/);
  });

  it("refunds a v2 capture charge on the capture rail (current platform)", async () => {
    const h = makeHarness({
      client: makeClient({
        getCapture: jest.fn().mockResolvedValue({
          id: "capt_1",
          status: "COMPLETED",
          amount: { value: "1.00", currency_code: "USD" },
        }),
        refundCapture: jest.fn().mockResolvedValue({ id: "ref_c1", status: "COMPLETED" }),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ first_sale_id: "capt_1" }));

    const result = await h.engine.refundSubscriptionPayment(
      { paypal_subscription_id: "I-ABC123", is_subscription: true, currency_code: "USD" },
      0.5
    );

    expect(h.client.refundCapture).toHaveBeenCalledWith(
      "capt_1",
      { value: "0.50", currency_code: "USD" },
      undefined
    );
    expect(h.client.refundSale).not.toHaveBeenCalled();
    expect(result.refundId).toBe("ref_c1");
  });

  it("full refund on the capture rail sends no amount (refunds remaining balance)", async () => {
    const h = makeHarness({
      client: makeClient({
        getCapture: jest.fn().mockResolvedValue({
          id: "capt_1",
          status: "PARTIALLY_REFUNDED",
          amount: { value: "1.00", currency_code: "USD" },
        }),
        refundCapture: jest.fn().mockResolvedValue({ id: "ref_c2", status: "COMPLETED" }),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ first_sale_id: "capt_1" }));

    await h.engine.refundSubscriptionPayment(
      { paypal_subscription_id: "I-ABC123", is_subscription: true, currency_code: "USD" },
      undefined
    );

    expect(h.client.refundCapture).toHaveBeenCalledWith("capt_1", undefined, undefined);
  });

  it("skips PayPal when the capture is already fully refunded", async () => {
    const h = makeHarness({
      client: makeClient({
        getCapture: jest.fn().mockResolvedValue({
          id: "capt_1",
          status: "REFUNDED",
          amount: { value: "1.00", currency_code: "USD" },
        }),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ first_sale_id: "capt_1" }));

    const result = await h.engine.refundSubscriptionPayment(
      { paypal_subscription_id: "I-ABC123", is_subscription: true },
      1
    );

    expect(result.saleId).toBe("capt_1");
    expect(h.client.refundCapture).not.toHaveBeenCalled();
    expect(h.client.refundSale).not.toHaveBeenCalled();
  });
});

describe("lifecycle actions", () => {
  it("cancels via PayPal, updates the row, and emits the event", async () => {
    const h = makeHarness();
    const row = await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    await h.engine.requestLifecycleAction(row[0], "cancel");

    expect(h.client.subscriptionAction).toHaveBeenCalledWith("I-ABC123", "cancel");
    expect(h.module.subscriptions[0].status).toBe("CANCELLED");
    expect(h.rail.payloads[0]).toMatchObject({ status: "cancelled", transition: "status" });
  });

  it("is idempotent - no event or API call when already in the target state", async () => {
    const h = makeHarness();
    const row = await h.module.createPaypalSubscriptions(makeRow({ status: "CANCELLED" }));

    await h.engine.requestLifecycleAction(row[0], "cancel");

    expect(h.client.subscriptionAction).not.toHaveBeenCalled();
    expect(h.rail.payloads).toHaveLength(0);
  });

  it("enforces ownership for customer self-service cancel", async () => {
    const h = makeHarness();
    const row = await h.module.createPaypalSubscriptions(makeRow({ customer_id: "cus_1" }));

    await expect(h.engine.customerCancel(row[0], "cus_other")).rejects.toThrow(
      MedusaError
    );
    expect(h.client.subscriptionAction).not.toHaveBeenCalled();

    await h.engine.customerCancel(row[0], "cus_1");
    expect(h.module.subscriptions[0].status).toBe("CANCELLED");
  });
});

describe("plan switch (revise)", () => {
  const monthly = makeVariant({ product_id: "prod_1" });
  const yearly = makeVariant({
    id: "variant_2",
    title: "Yearly Club",
    product_id: "prod_1",
    metadata: { paypal_subscription: { interval_unit: "YEAR", interval_count: 1 } },
    prices: [{ currency_code: "usd", amount: 199 }],
  });
  const otherProduct = makeVariant({
    id: "variant_3",
    title: "Poster Club",
    product_id: "prod_2",
  });

  it("switches the plan in place and mirrors the new interval", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    const row = await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1" })
    );

    const revised = await h.engine.customerRevise(row[0], "cus_1", {
      variantId: "variant_2",
    });

    expect(h.client.reviseSubscription).toHaveBeenCalledWith(
      "I-ABC123",
      "plan_P1",
      "revise-sub_1-plan_P1"
    );
    // In place: no cancel, no new subscription.
    expect(h.client.subscriptionAction).not.toHaveBeenCalled();
    expect(h.client.createSubscription).not.toHaveBeenCalled();
    // PayPal answered without a consent link, so the switch is already live.
    expect(revised.pending).toBe(false);
    expect(revised.approvalUrl).toBeNull();
    expect(revised.subscription).toMatchObject({
      variant_id: "variant_2",
      paypal_plan_id: "plan_P1",
      locked_amount: 199,
      interval_unit: "YEAR",
      interval_count: 1,
      status: "ACTIVE",
    });
    expect(h.rail.payloads.at(-1)).toMatchObject({
      transition: "status",
      status: "active",
      variant_id: "variant_2",
      plan_id: "plan_P1",
      interval_unit: "YEAR",
      interval_count: 1,
    });
  });

  it("is a no-op when the customer is already on that plan", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    const row = await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_2" })
    );

    const revised = await h.engine.customerRevise(row[0], "cus_1", {
      variantId: "variant_2",
    });

    expect(revised.pending).toBe(false);
    expect(revised.subscription.variant_id).toBe("variant_2");
    expect(h.client.reviseSubscription).not.toHaveBeenCalled();
    expect(h.rail.payloads).toHaveLength(0);
  });

  it("hands the buyer to PayPal when the revise needs consent", async () => {
    // Sandbox 2026-10-10: revise answers 200 with a rel=approve link and the
    // subscription keeps billing on the old plan until the buyer opens it
    // (PayPal docs: "This type of update requires the buyer's consent").
    const h = makeHarness({
      variants: [monthly, yearly],
      client: makeClient({
        reviseSubscription: jest.fn().mockResolvedValue({
          id: "I-ABC123",
          status: "ACTIVE",
          links: [
            {
              rel: "approve",
              href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-1NP47457MG4301629",
            },
          ],
        }),
      }),
    });
    const row = await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1" })
    );

    const result = await h.engine.customerRevise(row[0], "cus_1", {
      variantId: "variant_2",
    });

    expect(result.pending).toBe(true);
    expect(result.approvalUrl).toBe(
      "https://www.sandbox.paypal.com/webapps/billing/subscriptions/update?ba_token=BA-1NP47457MG4301629"
    );
    // Nothing local moved: writing the new plan here would show the customer a
    // plan PayPal is not billing yet.
    expect(result.subscription).toMatchObject({
      variant_id: "variant_1",
      locked_amount: 19.99,
      interval_unit: "MONTH",
    });
    expect(h.module.subscriptions[0]).toMatchObject({
      variant_id: "variant_1",
      interval_unit: "MONTH",
    });
    expect(h.rail.payloads).toHaveLength(0);
  });

  it("accepts a payer-action link as the consent URL too", async () => {
    const h = makeHarness({
      variants: [monthly, yearly],
      client: makeClient({
        reviseSubscription: jest.fn().mockResolvedValue({
          id: "I-ABC123",
          status: "ACTIVE",
          links: [{ rel: "payer-action", href: "https://www.paypal.com/payer-action/BA-1" }],
        }),
      }),
    });
    const row = await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    const result = await h.engine.customerRevise(row[0], "cus_1", {
      variantId: "variant_2",
    });

    expect(result).toMatchObject({
      pending: true,
      approvalUrl: "https://www.paypal.com/payer-action/BA-1",
    });
  });

  it("reuses the same idempotency key when the same switch is retried", async () => {
    const h = makeHarness({
      variants: [monthly, yearly],
      client: makeClient({
        reviseSubscription: jest
          .fn()
          .mockRejectedValueOnce(
            Object.assign(new Error("PayPal POST revise failed (500): boom"), {
              paypalStatus: 500,
            })
          )
          .mockResolvedValue({ id: "I-ABC123", status: "ACTIVE" }),
      }),
    });
    const row = await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1" })
    );

    await expect(
      h.engine.customerRevise(row[0], "cus_1", { variantId: "variant_2" })
    ).rejects.toThrow(/boom/);

    // PayPal's idempotency window is 72h: a retry of the same switch must
    // carry the same key or the plan change is applied twice.
    await h.engine.customerRevise(row[0], "cus_1", { variantId: "variant_2" });

    const keys = h.client.reviseSubscription.mock.calls.map((call: any[]) => call[2]);

    expect(keys).toEqual(["revise-sub_1-plan_P1", "revise-sub_1-plan_P1"]);
  });

  it("refuses a suspended subscription and points at resume", async () => {
    // PayPal answers 422 SUBSCRIPTION_STATUS_INVALID for a revise on anything
    // but an active agreement (sandbox 2026-10-10), so the refusal happens
    // before the call.
    const h = makeHarness({ variants: [monthly, yearly] });
    const row = await h.module.createPaypalSubscriptions(
      makeRow({ status: "SUSPENDED", variant_id: "variant_1" })
    );

    await expect(
      h.engine.customerRevise(row[0], "cus_1", { variantId: "variant_2" })
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringContaining("Resume the subscription first"),
    });
    expect(h.client.reviseSubscription).not.toHaveBeenCalled();
  });

  it("enforces ownership", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    const row = await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", customer_id: "cus_1" })
    );

    await expect(
      h.engine.customerRevise(row[0], "cus_other", { variantId: "variant_2" })
    ).rejects.toThrow(MedusaError);
    expect(h.client.reviseSubscription).not.toHaveBeenCalled();
  });

  it("refuses a cancelled subscription", async () => {
    const h = makeHarness({ variants: [monthly, yearly] });
    const row = await h.module.createPaypalSubscriptions(
      makeRow({ status: "CANCELLED", variant_id: "variant_1" })
    );

    await expect(
      h.engine.customerRevise(row[0], "cus_1", { variantId: "variant_2" })
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringContaining("cannot switch plans"),
    });
    expect(h.client.reviseSubscription).not.toHaveBeenCalled();
  });

  it("refuses a switch across products before calling PayPal", async () => {
    const h = makeHarness({ variants: [monthly, yearly, otherProduct] });
    const row = await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1" })
    );

    await expect(
      h.engine.customerRevise(row[0], "cus_1", { variantId: "variant_3" })
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringContaining("same product"),
    });
    expect(h.client.reviseSubscription).not.toHaveBeenCalled();
    expect(h.module.subscriptions[0].variant_id).toBe("variant_1");
  });

  it("surfaces PayPal's refusal as a customer-readable error", async () => {
    const h = makeHarness({
      variants: [monthly, yearly],
      client: makeClient({
        reviseSubscription: jest.fn().mockRejectedValue(
          Object.assign(new Error("PayPal POST revise failed (422): plan not compatible"), {
            paypalStatus: 422,
          })
        ),
      }),
    });
    const row = await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1" })
    );

    await expect(
      h.engine.customerRevise(row[0], "cus_1", { variantId: "variant_2" })
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: expect.stringContaining("PayPal rejected the plan switch"),
    });
    // The row keeps the old plan: nothing is written on a failed switch.
    expect(h.module.subscriptions[0].variant_id).toBe("variant_1");
    expect(h.rail.payloads).toHaveLength(0);
  });
});

describe("payment failure events", () => {
  it("increments the failure count and emits payment_failed", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow());

    await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", {
      billing_agreement_id: "I-ABC123",
      amount: { value: "19.99", currency_code: "USD" },
    });

    expect(h.module.subscriptions[0].failure_count).toBe(1);
    expect(h.rail.payloads[0]).toMatchObject({
      status: "past_due",
      transition: "payment_failed",
    });
    // The canonical fixture is the cross-repo contract: the payload carries
    // exactly its keys, and `kind` is this provider's own family (a consumer
    // joins on it — the provider cannot know its registration key).
    expect(Object.keys(h.rail.payloads[0]).sort()).toEqual(
      Object.keys(nativeSubscriptionChangedPayloads.paymentFailed).sort()
    );
    expect(h.rail.payloads[0].kind).toBe(PAYPAL_RAIL_KIND);
  });
});

describe("reconciliation", () => {
  it("aligns local status with PayPal and emits on change", async () => {
    const h = makeHarness({
      client: makeClient({
        getSubscription: jest.fn().mockResolvedValue({ id: "I-ABC123", status: "CANCELLED" }),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    const result = await h.engine.reconcile();

    expect(result.aligned).toBe(1);
    expect(h.module.subscriptions[0].status).toBe("CANCELLED");
    expect(h.rail.payloads[0]).toMatchObject({ status: "cancelled", transition: "status" });
  });

  it("heals a plan switch PayPal applied but no webhook reported", async () => {
    const yearly = makeVariant({
      id: "variant_2",
      title: "Yearly Club",
      product_id: "prod_1",
      metadata: { paypal_subscription: { interval_unit: "YEAR", interval_count: 1 } },
      prices: [{ currency_code: "usd", amount: 199 }],
    });
    const h = makeHarness({
      variants: [makeVariant(), yearly],
      client: makeClient({
        getSubscription: jest.fn().mockResolvedValue({
          id: "I-ABC123",
          status: "ACTIVE",
          plan_id: "plan_year",
          billing_info: { next_billing_time: "2026-11-10T10:00:00Z" },
        }),
      }),
    });
    await h.module.createPaypalSubscriptions(
      makeRow({ status: "ACTIVE", variant_id: "variant_1", paypal_plan_id: "plan_1" })
    );
    await h.module.createPaypalPlans({
      variant_id: "variant_2",
      currency_code: "usd",
      paypal_plan_id: "plan_year",
      config_hash: "hash_year",
    });

    const result = await h.engine.reconcile();

    expect(result.aligned).toBe(1);
    expect(h.module.subscriptions[0]).toMatchObject({
      variant_id: "variant_2",
      paypal_plan_id: "plan_year",
      locked_amount: 199,
      interval_unit: "YEAR",
    });
    expect(h.rail.payloads.at(-1)).toMatchObject({
      transition: "status",
      variant_id: "variant_2",
      plan_id: "plan_year",
    });
  });

  it("backfills a missed first-period sale through the standard workflow", async () => {
    const h = makeHarness({
      client: makeClient({
        getSubscription: jest.fn().mockResolvedValue({
          id: "I-ABC123",
          status: "ACTIVE",
          billing_info: { next_billing_time: "2026-10-19T00:00:00Z" },
        }),
        listSubscriptionTransactions: jest.fn().mockResolvedValue([
          { id: "sale_missed", status: "COMPLETED", amount: { value: "1.00" }, time: "2026-09-19T00:00:00Z" },
        ]),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    const result = await h.engine.reconcile();

    expect(result.salesBackfilled).toBe(1);
    expect(h.module.subscriptions[0].first_sale_id).toBe("sale_missed");
    expect(h.workflowEngine.run).toHaveBeenCalledWith("process-payment-workflow", {
      input: { action: "captured", data: { session_id: "sess_1", amount: 1 } },
    });
  });

  it("picks up stuck APPROVAL_PENDING rows: aligns status and backfills the missed first charge", async () => {
    const h = makeHarness({
      client: makeClient({
        getSubscription: jest.fn().mockResolvedValue({
          id: "I-ABC123",
          status: "ACTIVE",
          billing_info: { next_billing_time: "2026-10-19T00:00:00Z" },
        }),
        listSubscriptionTransactions: jest.fn().mockResolvedValue([
          { id: "sale_missed", status: "COMPLETED", amount: { value: "1.00" }, time: "2026-09-19T00:00:00Z" },
        ]),
      }),
    });
    await h.module.createPaypalSubscriptions(makeRow({ status: "APPROVAL_PENDING" }));

    const result = await h.engine.reconcile();

    expect(result.aligned).toBe(1);
    expect(result.salesBackfilled).toBe(1);
    expect(h.module.subscriptions[0].status).toBe("ACTIVE");
    expect(h.module.subscriptions[0].first_sale_id).toBe("sale_missed");
    expect(h.workflowEngine.run).toHaveBeenCalledWith("process-payment-workflow", {
      input: { action: "captured", data: { session_id: "sess_1", amount: 1 } },
    });
  });

  it("compensates never-returned first purchases (no sale, no order)", async () => {
    const h = makeHarness({ firstOrder: null });
    await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    const result = await h.engine.reconcile();

    expect(result.firstPurchasesBackfilled).toBe(1);
    expect(h.workflowEngine.run).toHaveBeenCalledWith("process-payment-workflow", {
      input: { action: "authorized", data: { session_id: "sess_1" } },
    });
  });

  it("is idempotent - a second run does nothing", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    await h.engine.reconcile();
    const second = await h.engine.reconcile();

    expect(second.salesBackfilled).toBe(0);
    expect(second.firstPurchasesBackfilled).toBe(0);
    expect(second.aligned).toBe(0);
    expect(h.orderModule.createOrders).not.toHaveBeenCalled();
  });

  it("backfills missed renewal orders for known first sales", async () => {
    const h = makeHarness({
      client: makeClient({
        getSubscription: jest.fn().mockResolvedValue({ id: "I-ABC123", status: "ACTIVE" }),
        listSubscriptionTransactions: jest.fn().mockResolvedValue([
          { id: "sale_2", status: "COMPLETED", amount: { value: "19.99" }, time: "2026-10-19T00:00:00Z" },
        ]),
      }),
    });
    await h.module.createPaypalSubscriptions(
      makeRow({
        status: "ACTIVE",
        first_sale_id: "sale_1",
        sales: [{ sale_id: "sale_1", amount: 1, currency_code: "usd" }],
      })
    );

    const result = await h.engine.reconcile();

    expect(result.salesBackfilled).toBe(1);
    expect(h.orderModule.createOrders).toHaveBeenCalledTimes(1);
    expect(h.workflowEngine.run).not.toHaveBeenCalled();
  });
});
