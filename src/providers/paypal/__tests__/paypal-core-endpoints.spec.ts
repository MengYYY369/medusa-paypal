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
});
