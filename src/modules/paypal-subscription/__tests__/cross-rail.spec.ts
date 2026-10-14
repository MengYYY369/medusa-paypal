import { CROSS_RAIL_MODULE_KEYS, resolveCrossRailModule } from "../lib/cross-rail";

/**
 * The cross-rail lookup is what makes the exclusivity guard see the host's own
 * subscription rail. 0.11.0 tried only `reorder`, which is NOT the key
 * `@mengyyy369/reorder` registers (`SUBSCRIPTION_MODULE = "subscription"`), so
 * on the host this was written for the module resolved to `undefined` and the
 * check silently stayed native-only. These cases pin the order and the
 * fallback.
 */
describe("resolveCrossRailModule", () => {
  const scopeWith = (registrations: Record<string, unknown>) => ({
    resolve: (key: string) => {
      if (!(key in registrations)) {
        throw new Error(`Could not resolve '${key}'`);
      }
      return registrations[key];
    },
  });

  it("prefers the key reorder actually registers", () => {
    const module = { listSubscriptions: jest.fn() };
    const scope = scopeWith({ subscription: module, reorder: { other: true } });

    expect(resolveCrossRailModule(scope)).toBe(module);
    expect(CROSS_RAIL_MODULE_KEYS[0]).toBe("subscription");
  });

  it("falls back to the package name when the host aliases it", () => {
    const module = { listSubscriptions: jest.fn() };
    const scope = scopeWith({ reorder: module });

    expect(resolveCrossRailModule(scope)).toBe(module);
  });

  it("answers undefined when the host has no such module", () => {
    expect(resolveCrossRailModule(scopeWith({}))).toBeUndefined();
    expect(resolveCrossRailModule({ resolve: () => null })).toBeUndefined();
    expect(resolveCrossRailModule(undefined)).toBeUndefined();
  });
});
