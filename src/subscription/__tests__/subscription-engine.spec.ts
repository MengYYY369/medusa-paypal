import { MedusaError } from "@medusajs/framework/utils";
import { SubscriptionEngine } from "../engine";
import { parseSubscriptionMetadata } from "../metadata";
import { PaypalSubscriptionEvents } from "../events";
import {
  FakeSubscriptionModule,
  makeEventBus,
  makeFirstOrder,
  makeOrderModule,
  makePaymentModule,
  makeProductModule,
  makeRow,
  makeVariant,
  makeWorkflowEngine,
} from "./fakes";

const loggerStub = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    createBillingProduct: jest.fn().mockResolvedValue({ id: "prod_P1" }),
    createBillingPlan: jest.fn().mockResolvedValue({ id: "plan_P1" }),
    createSubscription: jest.fn().mockResolvedValue({
      id: "I-NEW",
      status: "APPROVAL_PENDING",
      links: [{ rel: "approve", href: "https://www.paypal.com/approve" }],
    }),
    getSubscription: jest.fn().mockResolvedValue({ id: "I-ABC123", status: "ACTIVE" }),
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
  client: any;
  productModule: ReturnType<typeof makeProductModule>;
  orderModule: ReturnType<typeof makeOrderModule>;
  paymentModule: ReturnType<typeof makePaymentModule>;
  workflowEngine: ReturnType<typeof makeWorkflowEngine>;
  engine: SubscriptionEngine;
};

function makeHarness(opts: {
  variants?: any[];
  firstOrder?: any;
  client?: any;
} = {}): Harness {
  const subscriptionModule = new FakeSubscriptionModule();
  const eventBus = makeEventBus();
  const client = opts.client ?? makeClient();
  const productModule = makeProductModule(opts.variants ?? [makeVariant()]);
  const orderModule = makeOrderModule(
    "firstOrder" in opts ? opts.firstOrder : makeFirstOrder()
  );
  const paymentModule = makePaymentModule();
  const workflowEngine = makeWorkflowEngine();

  const engine = new SubscriptionEngine({
    client,
    logger: loggerStub as never,
    eventBus: eventBus as any,
    subscriptionModule: subscriptionModule as any,
    productModule,
    orderModule,
    paymentModule,
    workflowEngine,
  });

  return {
    module: subscriptionModule,
    eventBus,
    client,
    productModule,
    orderModule,
    paymentModule,
    workflowEngine,
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
      paypal_subscription: '{"interval_unit":"YEAR","interval_count":1,"setup_fee":500}',
    });

    expect(config?.setup_fee).toBe(500);
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
  it("creates product + plan on first use and caches by config hash", async () => {
    const h = makeHarness();

    const variant = makeVariant();
    const first = await h.engine.ensurePlan({
      variant,
      config: { interval_unit: "MONTH", interval_count: 1, product_type: "SERVICE" },
      currencyCode: "usd",
      amount: 1999,
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
      amount: 1999,
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
      amount: 1999,
    });

    await h.engine.ensurePlan({
      variant: makeVariant({ prices: [{ currency_code: "usd", amount: 2499 }] }),
      config: { interval_unit: "MONTH", interval_count: 1, product_type: "SERVICE" },
      currencyCode: "usd",
      amount: 2499,
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
        setup_fee: 100,
        product_type: "SERVICE",
      },
      currencyCode: "usd",
      amount: 1999,
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

describe("session initiation", () => {
  it("creates the PayPal subscription with custom_id = session id and records the row", async () => {
    const h = makeHarness();

    const result = await h.engine.initiateSubscriptionSession({
      sessionId: "sess_1",
      variantId: "variant_1",
      currencyCode: "usd",
      amount: 1999,
      customerId: "cus_1",
    });

    expect(h.client.createSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ plan_id: "plan_P1", custom_id: "sess_1" })
    );
    expect(result.row.status).toBe("APPROVAL_PENDING");
    expect(result.row.payment_session_id).toBe("sess_1");
    expect(result.row.locked_amount).toBe(1999);
    expect(result.approveLink).toBe("https://www.paypal.com/approve");
  });

  it("is idempotent per session (Buttons route cannot double-create)", async () => {
    const h = makeHarness();

    const first = await h.engine.initiateSubscriptionSession({
      sessionId: "sess_1",
      variantId: "variant_1",
      currencyCode: "usd",
      amount: 1999,
    });
    const second = await h.engine.initiateSubscriptionSession({
      sessionId: "sess_1",
      variantId: "variant_1",
      currencyCode: "usd",
      amount: 1999,
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
    expect(h.eventBus.emitted).toEqual([
      expect.objectContaining({ name: PaypalSubscriptionEvents.ACTIVATED }),
    ]);
    expect(h.orderModule.createOrders).not.toHaveBeenCalled();
  });

  it("emits resumed (not activated) when a suspended subscription reactivates", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "SUSPENDED" }));

    await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.ACTIVATED", { id: "I-ABC123" });

    expect(h.eventBus.emitted[0].name).toBe(PaypalSubscriptionEvents.RESUMED);
  });

  it("ignores unknown subscriptions", async () => {
    const h = makeHarness();

    const result = await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.CANCELLED", {
      id: "I-UNKNOWN",
    });

    expect(result).toEqual({ action: "not_supported" });
    expect(h.eventBus.emitted).toHaveLength(0);
  });

  it("is idempotent on duplicate state events", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "CANCELLED" }));

    await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.CANCELLED", { id: "I-ABC123" });

    expect(h.eventBus.emitted).toHaveLength(0);
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
      data: { session_id: "sess_1", amount: 100 },
    });
    expect(h.module.subscriptions[0].first_sale_id).toBe("sale_1");
    expect(h.orderModule.createOrders).not.toHaveBeenCalled(); // cart completion owns the first order
    expect(h.eventBus.emitted).toEqual([
      expect.objectContaining({ name: PaypalSubscriptionEvents.PAYMENT_SUCCEEDED }),
    ]);
  });

  it("is idempotent for duplicate sale deliveries", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow({ status: "ACTIVE" }));

    const payload = { id: "sale_1", billing_agreement_id: "I-ABC123", amount: { value: "1.00" } };

    await h.engine.handleWebhookEvent("PAYMENT.SALE.COMPLETED", payload);
    const second = await h.engine.handleWebhookEvent("PAYMENT.SALE.COMPLETED", payload);

    expect(second).toEqual({ action: "not_supported" });
    expect(h.eventBus.emitted).toHaveLength(1);
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
          { sale_id: "sale_1", amount: 100, currency_code: "usd", billed_at: "2026-09-19T00:00:00Z" },
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
    expect(orderInput.items[0]).toMatchObject({ title: "Monthly Club", unit_price: 1999 });
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
    expect(h.eventBus.emitted[0]).toMatchObject({
      name: PaypalSubscriptionEvents.PAYMENT_SUCCEEDED,
      data: expect.objectContaining({
        payment: expect.objectContaining({ sale_id: "sale_2", order_id: "order_renewal_1" }),
      }),
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
        sales: [{ sale_id: "sale_1", amount: 1999, currency_code: "usd" }],
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
      amount: 1999,
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
      1999
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
      1999
    );

    expect(refunded.client.refundSale).not.toHaveBeenCalled();
  });

  it("throws a clear error when no sale exists (free trial not yet billed)", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow());

    await expect(
      h.engine.refundSubscriptionPayment({ paypal_subscription_id: "I-ABC123", is_subscription: true }, 100)
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
      50
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
      100
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
    expect(h.eventBus.emitted[0].name).toBe(PaypalSubscriptionEvents.CANCELLED);
  });

  it("is idempotent - no event or API call when already in the target state", async () => {
    const h = makeHarness();
    const row = await h.module.createPaypalSubscriptions(makeRow({ status: "CANCELLED" }));

    await h.engine.requestLifecycleAction(row[0], "cancel");

    expect(h.client.subscriptionAction).not.toHaveBeenCalled();
    expect(h.eventBus.emitted).toHaveLength(0);
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

describe("payment failure events", () => {
  it("increments the failure count and emits payment_failed", async () => {
    const h = makeHarness();
    await h.module.createPaypalSubscriptions(makeRow());

    await h.engine.handleWebhookEvent("BILLING.SUBSCRIPTION.PAYMENT.FAILED", {
      billing_agreement_id: "I-ABC123",
      amount: { value: "19.99", currency_code: "USD" },
    });

    expect(h.module.subscriptions[0].failure_count).toBe(1);
    expect(h.eventBus.emitted[0].name).toBe(PaypalSubscriptionEvents.PAYMENT_FAILED);
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
    expect(h.eventBus.emitted[0].name).toBe(PaypalSubscriptionEvents.CANCELLED);
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
      input: { action: "captured", data: { session_id: "sess_1", amount: 100 } },
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
        sales: [{ sale_id: "sale_1", amount: 100, currency_code: "usd" }],
      })
    );

    const result = await h.engine.reconcile();

    expect(result.salesBackfilled).toBe(1);
    expect(h.orderModule.createOrders).toHaveBeenCalledTimes(1);
    expect(h.workflowEngine.run).not.toHaveBeenCalled();
  });
});
