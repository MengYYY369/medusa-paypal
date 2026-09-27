import { paypalSubscriptionMetadataSchema } from "../metadata"

const base = {
  interval_unit: "MONTH" as const,
  interval_count: 1,
  product_type: "SERVICE" as const,
}

describe("paypal subscription metadata money fields", () => {
  it("accepts two-decimal major amounts", () => {
    expect(
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: 9.99 })
    ).toBeTruthy()
    expect(
      paypalSubscriptionMetadataSchema.parse({
        ...base,
        trial_periods: [{ unit: "DAY", count: 7, price: 1.99 }],
      })
    ).toBeTruthy()
  })

  it("accepts zero-decimal and three-decimal amounts per ISO 4217", () => {
    // JPY (dd=0): whole numbers only; KWD (dd=3): up to 3 decimals
    expect(
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: 100 })
    ).toBeTruthy()
    expect(
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: 9.999 })
    ).toBeTruthy()
  })

  it("rejects non-numeric, over-precise (>3 decimals), and negative amounts", () => {
    // multipleOf(0.001) means max 3 decimal places allowed
    expect(() =>
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: "9.99" as never })
    ).toThrow()
    expect(() =>
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: 9.9999 })
    ).toThrow()
    expect(() =>
      paypalSubscriptionMetadataSchema.parse({ ...base, setup_fee: -1 })
    ).toThrow()
  })

  it("keeps counts and intervals integers", () => {
    expect(() =>
      paypalSubscriptionMetadataSchema.parse({ ...base, interval_count: 1.5 })
    ).toThrow()
  })
})