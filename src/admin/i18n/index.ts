/**
 * Admin translations consumed by the Medusa admin bundler through the
 * `virtual:medusa/i18n` convention: the dashboard deep-merges these resources
 * over its own catalogs and resolves any `defineRouteConfig` label carrying a
 * `translationNs` hint with `t(label, { ns })`.
 *
 * This namespace exists for host-rendered strings the plugin cannot reach -
 * the sidebar label. Page copy lives in the zero-dependency dictionary
 * (`src/admin/lib/i18n.ts`) instead. Keys follow the host convention
 * `<domain>.<area>`, `menuItems.*` is reserved for sidebar labels, and the
 * English value is a byte-for-byte copy of the label that shipped before i18n.
 */
export default {
  en: {
    paypal: {
      menuItems: {
        subscriptions: "PayPal Subscriptions",
      },
    },
  },
  zhCN: {
    paypal: {
      menuItems: {
        subscriptions: "PayPal 订阅",
      },
    },
  },
}
