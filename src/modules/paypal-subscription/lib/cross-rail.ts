/**
 * Resolves the host's own subscription engine (reorder), when this host has
 * one.
 *
 * The cross-rail half of the exclusivity check reads it: a live row there
 * covers the same Medusa product, so a second PayPal agreement for that
 * product would charge the customer twice. It is OPTIONAL on purpose - a host
 * that never registered the module, or runs a version without
 * `listSubscriptions`, has to keep working exactly as it did before, which is
 * what `undefined` buys here.
 *
 * Two names are tried, in order:
 *   - `subscription` - the key `@mengyyy369/reorder` actually registers
 *     (`SUBSCRIPTION_MODULE = "subscription"` in its module definition);
 *   - `reorder` - the package name, kept for hosts that alias it explicitly.
 * 0.11.0 shipped with only the second one, which silently resolved to
 * `undefined` on the host this feature was written for, so the check fell back
 * to native-only without saying anything.
 *
 * Awilix throws on an unknown name (through the cradle and through `resolve`),
 * so each lookup is guarded rather than assumed.
 */
export const CROSS_RAIL_MODULE_KEYS = ["subscription", "reorder"] as const;

export function resolveCrossRailModule(scope: any): any {
  for (const key of CROSS_RAIL_MODULE_KEYS) {
    try {
      const module = scope?.resolve?.(key);
      if (module) {
        return module;
      }
    } catch {
      // Unknown key: try the next name.
    }
  }
  return undefined;
}
