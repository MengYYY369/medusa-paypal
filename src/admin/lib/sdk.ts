import Medusa from "@medusajs/js-sdk"

declare const __BACKEND_URL__: string

/**
 * Admin SDK instance for plugin extension pages. The dashboard authenticates
 * via the /auth/session cookie, so this client must declare session auth:
 * js-sdk then sends cookies (credentials: "include") and skips the
 * localStorage JWT lookup entirely.
 */
export const sdk = new Medusa({
  baseUrl: __BACKEND_URL__ || window.location.origin,
  debug: false,
  auth: { type: "session" },
})
