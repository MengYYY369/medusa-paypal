import Medusa from "@medusajs/js-sdk"

declare const __BACKEND_URL__: string

/**
 * Admin SDK instance for plugin extension pages. The admin dashboard stores
 * its auth token under `medusa_auth_token` in localStorage; the SDK default
 * storage key matches, so requests made with this client carry the logged-in
 * admin's credentials automatically.
 */
export const sdk = new Medusa({
  baseUrl: __BACKEND_URL__ || window.location.origin,
  debug: false,
})
