/**
 * In-memory fakes for the subscription test seam: the engine and the provider
 * are tested against these - never against real repositories.
 */

export function makeVariant(overrides: Record<string, unknown> = {}) {
  return {
    id: "variant_1",
    title: "Monthly Club",
    metadata: {
      paypal_subscription: {
        interval_unit: "MONTH",
        interval_count: 1,
      },
    },
    prices: [{ currency_code: "usd", amount: 1999 }],
    ...overrides,
  };
}

export class FakeSubscriptionModule {
  plans: any[] = [];
  subscriptions: any[] = [];
  private seq = 0;

  private nextId(prefix: string) {
    return `${prefix}_${++this.seq}`;
  }

  async listPaypalPlans(filters: any = {}) {
    return this.plans.filter((plan) =>
      Object.entries(filters).every(
        ([key, value]) => plan[key] === value || value === undefined
      )
    );
  }

  async createPaypalPlans(data: any) {
    const rows = (Array.isArray(data) ? data : [data]).map((row) => ({
      id: this.nextId("plan"),
      status: "ACTIVE",
      ...row,
    }));

    this.plans.push(...rows);
    return rows;
  }

  async listPaypalSubscriptions(filters: any = {}) {
    return this.subscriptions.filter((row) =>
      Object.entries(filters).every(([key, value]) => {
        if (Array.isArray(value)) {
          return value.includes(row[key]);
        }
        return row[key] === value || value === undefined;
      })
    );
  }

  async listAndCountPaypalSubscriptions(filters: any = {}) {
    const rows = await this.listPaypalSubscriptions(filters);
    return [rows, rows.length];
  }

  async createPaypalSubscriptions(data: any) {
    const rows = (Array.isArray(data) ? data : [data]).map((row) => ({
      failure_count: 0,
      sales: [],
      refunds: [],
      ...row,
      id: this.nextId("sub"),
    }));

    this.subscriptions.push(...rows);
    return rows;
  }

  async retrievePaypalSubscription(id: string) {
    const row = this.subscriptions.find((row) => row.id === id);

    if (!row) {
      const { MedusaError } = require("@medusajs/framework/utils");
      throw new MedusaError(MedusaError.Types.NOT_FOUND, "not found");
    }

    return row;
  }

  async updatePaypalSubscriptions(data: any) {
    const rows = (Array.isArray(data) ? data : [data]).map((patch) => {
      const row = this.subscriptions.find((candidate) => candidate.id === patch.id);

      if (!row) {
        throw new Error(`no row ${patch.id}`);
      }

      Object.assign(row, patch);
      return row;
    });

    return rows;
  }
}

export function makeEventBus() {
  const emitted: { name: string; data: any }[] = [];

  return {
    emitted,
    emit: jest.fn(async (event: any) => {
      emitted.push(event);
    }),
  };
}

export function makeProductModule(variants: any[]) {
  const list = async (filters: any) => {
    const ids = filters?.id;

    return variants.filter((variant) => !ids || ids.includes(variant.id));
  };

  return {
    // 2.20+ product modules expose listProductVariants; listVariants kept
    // for older-version compatibility paths.
    listProductVariants: jest.fn(list),
    listVariants: jest.fn(list),
  };
}

export function makeFirstOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_first",
    currency_code: "usd",
    customer_id: "cus_1",
    email: "buyer@example.com",
    region_id: "reg_1",
    payment_collection_id: "col_first",
    items: [
      {
        title: "Monthly Club",
        quantity: 1,
        unit_price: 1999,
        variant_id: "variant_1",
        product_id: "prod_1",
      },
    ],
    ...overrides,
  };
}

export function makeOrderModule(firstOrder: any) {
  const created: any[] = [];

  return {
    created,
    listOrders: jest.fn(async (filters: any) => {
      if (filters?.payment_collection_id === "col_first") {
        return firstOrder ? [firstOrder] : [];
      }

      return created.filter(
        (order) => order.payment_collection_id === filters?.payment_collection_id
      );
    }),
    createOrders: jest.fn(async (inputs: any[]) => {
      const rows = inputs.map((input, index) => ({
        id: `order_renewal_${created.length + index + 1}`,
        status: "pending",
        ...input,
      }));

      created.push(...rows);
      return rows;
    }),
  };
}

export function makePaymentModule() {
  let seq = 0;

  return {
    retrievePaymentSession: jest.fn(async (sessionId: string) => ({
      id: sessionId,
      provider_id: "pp_paypal_paypal",
      payment_collection_id: "col_first",
      currency_code: "usd",
    })),
    createPaymentCollections: jest.fn(async (inputs: any[]) =>
      inputs.map((input) => ({ id: `col_renewal_${++seq}`, ...input }))
    ),
    createPaymentSession: jest.fn(async (collectionId: string, input: any) => ({
      id: `sess_renewal_${seq}`,
      payment_collection_id: collectionId,
      ...input,
    })),
    authorizePaymentSession: jest.fn(async (sessionId: string) => ({
      id: `pay_renewal_${seq}`,
      session_id: sessionId,
    })),
    capturePayment: jest.fn(async (input: any) => ({
      id: input.payment_id,
      captured: true,
    })),
    listPaymentCollections: jest.fn(async () => [
      {
        id: "col_first",
        payments: [
          { id: "pay_first", amount: 1999, refunds: [] },
        ],
      },
    ]),
    listPayments: jest.fn(async (filters: any) => [
      { id: "pay_first", payment_collection_id: filters?.payment_collection_id },
    ]),
    refundPayment: jest.fn(async (input: any) => ({
      id: input.payment_id,
      refunded: input.amount,
    })),
  };
}

export function makeWorkflowEngine() {
  const runs: { id: string; input: any }[] = [];

  return {
    runs,
    run: jest.fn(async (id: string, args: any) => {
      runs.push({ id, input: args?.input });
    }),
  };
}

/** Standard ACTIVE subscription row shaped like the module rows. */
export function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sub_1",
    paypal_subscription_id: "I-ABC123",
    paypal_plan_id: "plan_1",
    variant_id: "variant_1",
    customer_id: "cus_1",
    payment_session_id: "sess_1",
    payment_collection_id: "col_first",
    provider_id: "pp_paypal_paypal",
    status: "ACTIVE",
    locked_amount: 1999,
    currency_code: "usd",
    interval_unit: "MONTH",
    interval_count: 1,
    first_sale_id: null,
    next_billing_at: null,
    last_billing_at: null,
    failure_count: 0,
    sales: [],
    refunds: [],
    metadata: {},
    ...overrides,
  };
}
