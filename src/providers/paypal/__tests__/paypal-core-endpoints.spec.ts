import { OrdersController } from "@paypal/paypal-server-sdk";
import { MedusaError } from "@medusajs/framework/utils";
import { PaypalService } from "../paypal-core";

/**
 * Endpoint-path regression locks for the raw billing client. The first
 * contract run against the live sandbox caught createBillingProduct posting
 * to /v1/billing/products (a route PayPal does not serve - products live
 * under /v1/catalogs), which unit tests missed because the client is mocked
 * everywhere else. These tests pin the real URLs.
 */

const sandboxBase = "https://api-m.sandbox.paypal.com";

function makeClient(): PaypalService {
  const client = new PaypalService({
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
    isSandbox: true,
    includeShippingData: false,
    includeCustomerData: false,
  });

  jest.spyOn(client, "getAccessToken").mockResolvedValue("test-token");

  const fetchMock = jest.fn().mockResolvedValue(
    new Response(JSON.stringify({ id: "FAKE-ID" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    })
  );
  (global as any).fetch = fetchMock;

  return client;
}

async function lastFetchCall(): Promise<[string, RequestInit]> {
  const fetchMock = (global as any).fetch as jest.Mock;
  const calls = fetchMock.mock.calls;
  return calls[calls.length - 1];
}

describe("paypal-core billing endpoint paths", () => {
  it("createBillingProduct posts to /v1/catalogs/products", async () => {
    const client = makeClient();

    await client.createBillingProduct({ name: "P", type: "SERVICE" });

    const [url, init] = await lastFetchCall();
    expect(url).toBe(`${sandboxBase}/v1/catalogs/products`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      name: "P",
      type: "SERVICE",
    });
  });

  it("createBillingPlan posts to /v1/billing/plans", async () => {
    const client = makeClient();

    await client.createBillingPlan({
      product_id: "PROD-1",
      name: "Plan",
      billing_cycles: [],
    });

    const [url] = await lastFetchCall();
    expect(url).toBe(`${sandboxBase}/v1/billing/plans`);
  });

  it("createSubscription posts to /v1/billing/subscriptions", async () => {
    const client = makeClient();

    await client.createSubscription({ plan_id: "PLAN-1", custom_id: "session" });

    const [url] = await lastFetchCall();
    expect(url).toBe(`${sandboxBase}/v1/billing/subscriptions`);
  });

  it("getCapture reads /v2/payments/captures (subscription charges are captures)", async () => {
    const client = makeClient();

    await client.getCapture("CAPT-1");

    const [url] = await lastFetchCall();
    expect(url).toBe(`${sandboxBase}/v2/payments/captures/CAPT-1`);
  });

  it("refundCapture posts to /v2/payments/captures/{id}/refund", async () => {
    const client = makeClient();

    await client.refundCapture(
      "CAPT-1",
      { value: "1.00", currency_code: "USD" },
      "oops"
    );

    const [url, init] = await lastFetchCall();
    expect(url).toBe(`${sandboxBase}/v2/payments/captures/CAPT-1/refund`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      amount: { value: "1.00", currency_code: "USD" },
      note_to_payer: "oops",
    });
  });

  it("refundCapture without amount sends no amount (full remaining refund)", async () => {
    const client = makeClient();

    await client.refundCapture("CAPT-1");

    const [, init] = await lastFetchCall();
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  it("subscriptionAction posts the reason to /{action}", async () => {
    const client = makeClient();

    await client.subscriptionAction("I-1", "cancel", "Abandoned checkout");

    const [url, init] = await lastFetchCall();
    expect(url).toBe(`${sandboxBase}/v1/billing/subscriptions/I-1/cancel`);
    expect(init.method).toBe("POST");
    // The cancel endpoint takes `reason` (required, 1-128 chars), not `note` -
    // that field belongs to the refund endpoints above.
    expect(JSON.parse(String(init.body))).toEqual({
      reason: "Abandoned checkout",
    });
  });

  it("subscriptionAction defaults the reason when the caller omits it", async () => {
    const client = makeClient();

    await client.subscriptionAction("I-2", "suspend");

    const [url, init] = await lastFetchCall();
    expect(url).toBe(`${sandboxBase}/v1/billing/subscriptions/I-2/suspend`);
    expect(JSON.parse(String(init.body))).toEqual({ reason: "Managed via Medusa" });
  });

  it("reviseSubscription posts the target plan to /revise", async () => {
    const client = makeClient();

    await client.reviseSubscription("I-3", "P-3", "revise-sub_1-P-3");

    const [url, init] = await lastFetchCall();
    expect(url).toBe(`${sandboxBase}/v1/billing/subscriptions/I-3/revise`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ plan_id: "P-3" });
  });

  it("reviseSubscription sends the caller's idempotency key verbatim", async () => {
    const client = makeClient();
    // A fresh Response per call: the shared mock hands back one object whose
    // body is consumed by the first read.
    (global as any).fetch = jest.fn(async () =>
      new Response(JSON.stringify({ id: "FAKE-ID" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await client.reviseSubscription("I-3", "P-3", "revise-sub_1-P-3");
    await client.reviseSubscription("I-3", "P-3", "revise-sub_1-P-3");

    const headers = ((global as any).fetch as jest.Mock).mock.calls.map(
      (call: any[]) => call[1].headers["PayPal-Request-Id"]
    );

    // A retry must not mint a fresh key: PayPal holds the key for 72h and a
    // new one would apply the plan change twice.
    expect(headers).toEqual(["revise-sub_1-P-3", "revise-sub_1-P-3"]);
  });

  it("still mints its own idempotency key for callers that pass none", async () => {
    const client = makeClient();

    await client.createBillingPlan({ product_id: "P-1", name: "P", billing_cycles: [] });

    const [, init] = await lastFetchCall();
    expect(
      (init.headers as Record<string, string>)["PayPal-Request-Id"]
    ).toEqual(expect.any(String));
  });
});

/**
 * The purchase-unit item contract (README §6). `createOrder` is the only place
 * session items are mapped, so its guard is what turns a missing field into a
 * named error instead of a `TypeError` from `undefined.toString()` or a literal
 * `"NaN"` in `unit_amount.value`. Orders go through the SDK's axios client
 * rather than `global.fetch`, so these tests spy on the controller itself.
 */
describe("paypal-core purchase-unit items", () => {
  let sdkCreateOrder: jest.SpyInstance;

  const orderWith = (items: unknown) => ({
    amount: 9.99,
    currency: "USD",
    fractionDigits: 2,
    sessionId: "sess_1",
    items: items as never,
  });

  const itemsOnTheWire = () =>
    sdkCreateOrder.mock.calls[0][0].body.purchaseUnits[0].items;

  beforeEach(() => {
    sdkCreateOrder = jest
      .spyOn(OrdersController.prototype, "createOrder")
      .mockResolvedValue({ result: { id: "ORDER-1" } } as never);
  });

  afterEach(() => {
    sdkCreateOrder.mockRestore();
  });

  it("maps a complete item onto the wire payload", async () => {
    const client = makeClient();

    await client.createOrder(
      orderWith([{ title: "Pro Plan - Monthly", unit_price: 9.99, quantity: 1 }])
    );

    expect(itemsOnTheWire()).toEqual([
      {
        name: "Pro Plan - Monthly",
        quantity: "1",
        unitAmount: { currencyCode: "USD", value: "9.99" },
      },
    ]);
  });

  it("rejects an item without a title before the SDK is reached", async () => {
    const client = makeClient();

    await expect(
      client.createOrder(orderWith([{ unit_price: 9.99, quantity: 1 }]))
    ).rejects.toMatchObject({
      type: MedusaError.Types.INVALID_DATA,
      message: "Invalid item at index 0: title is required",
    });

    expect(sdkCreateOrder).not.toHaveBeenCalled();
  });
});
