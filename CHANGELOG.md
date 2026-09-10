# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-09-10

First release of the forked package `@mengyyy369/medusa-paypal`, based on
upstream `@alphabite/medusa-paypal` 0.2.6.

### Added

- Vaulted off-session renewals: `customer_id` in the checkout payment session
  data saves a PayPal v3 payment token (`store_in_vault: ON_SUCCESS`) on
  captured orders, and the captured vault id is mirrored into the session data
  as `payment_method` (plus `vault_id` and `vault_status`) so subscription
  engines can store it as the reusable payment method reference.
- Merchant-initiated charging: `initiatePayment` short-circuits sessions that
  carry `off_session: true` and `payment_method` without creating a PayPal
  order, and `authorizePayment` creates and captures the order against the
  vault token with no buyer interaction.
- `decline_code` on off-session failures: every declined vault charge throws
  `UNAUTHORIZED` carrying the PayPal decline reason so dunning flows can
  classify it (for example `INSUFFICIENT_FUNDS`, `INSTRUMENT_DECLINED`).
- `redirect_url` on payment session data: the PayPal approval link is exposed
  for redirect-based (manual) renewal flows.
- `createAccountHolder` and `listPaymentMethods` hooks: saved PayPal wallets
  surface through the standard Payment Module interface as
  `{ id, data: { type: "paypal", email } }`.
- `POST /store/paypal/account-holder` route for storefront onboarding of the
  customer's PayPal account holder.

### Changed

- Renamed the package to `@mengyyy369/medusa-paypal` with neutral type names
  (`PaypalPluginOptions`), updated repository URLs, keywords and README.
- Aligned with Medusa 2.20: `initiatePayment` returns the session `id`
  required by current Medusa versions; peer dependencies updated to 2.20.0.
- Webhook handling: verification failures now map to `not_supported` instead
  of `failed`, so unverifiable events can no longer tear down payment
  sessions; `PAYMENT.CAPTURE.DECLINED` maps to `failed` for checkout sessions
  and `not_supported` when no session is referenced.

### Fixed

- The client-token route imported the package by its old self-name and a
  source path, both of which break at runtime; it now uses relative imports.
- `zod` is pinned as an explicit dependency (previously relied on hoisting).

### Testing

- Jest setup with 26 unit tests covering buyer-initiated payments, off-session
  vault charges, vault write-back, saved methods, account holders and webhook
  mapping.
