# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-19

### Added

- **Official PayPal Subscriptions (Billing Subscriptions API)** as a second,
  parallel billing path alongside vaulted renewals. Adoption is per-variant:
  metadata key `paypal_subscription` (interval/frequency, one trial period,
  setup fee, product type) turns a variant into a subscription product; the
  recurring price always comes from the variant's live per-currency price.

- **Plan auto-management**: PayPal products and billing plans are created on
  demand and cached in a new `paypal_plan` table keyed by variant x currency
  x configuration hash (plans are immutable on PayPal, so any price/config
  change mints a new plan version automatically). Admin route
  `POST /admin/paypal/plans/sync` for manual provisioning/inspection.

- **First-purchase checkout** (`initiatePayment` subscription branch): mixed
  subscription/regular carts are rejected with clear guidance; the PayPal
  subscription is created with the payment session id as `custom_id`, the
  approve link is exposed as `redirect_url`, and Buttons storefronts get the
  idempotent get-or-create route `POST /store/paypal/subscriptions`. The
  first order is created by the standard cart completion
  (`authorizePayment` subscription branch); the first charge flows through
  the standard captured mechanism via `PAYMENT.SALE.COMPLETED`. First-period
  amount semantics (setup fee / free trial) are exposed on events, not
  masked.

- **Subscription webhook route** `POST /hooks/paypal/subscriptions` for a
  second PayPal webhook carrying only subscription-class events
  (`BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.*`); payment-class events are
  acknowledged but never forwarded (no double delivery). New option
  `subscriptionWebhookId` (falls back to `webhookId`); signature verification
  tries both ids so mixed topologies keep working.

- **Renewal orders**: every subsequent `PAYMENT.SALE.COMPLETED` creates a
  renewal Medusa order through the injected order module - same customer,
  first-order items at locked prices, digital (no shipping), PayPal sale id
  stored on the payment as the refund anchor; duplicate events are
  idempotent. Failure events increment the subscription failure counter.

- **Bidirectional refund sync**: panel refunds (`PAYMENT.SALE.REFUNDED` /
  `REVERSED`) create Medusa refunds on the matching order (full refunds auto-
  recorded; partial refunds recorded on the subscription row), and Medusa
  Admin refunds on subscription payments refund the PayPal sale via the new
  provider branch (previously they errored on the Orders-v2-only structure).

- **Lifecycle APIs**: admin list/detail/`cancel`/`suspend`/`resume`
  (`/admin/paypal/subscriptions[...]`) and customer self-service
  (`GET /store/paypal/subscriptions`,
  `POST /store/paypal/subscriptions/:id/cancel` with ownership checks). All
  state changes - admin, customer, inbound PayPal webhooks, or PayPal-side
  self-service - emit `paypal.subscription.activated / suspended / resumed /
  cancelled / expired / payment_succeeded / payment_failed` events, only on
  actual state transitions.

- **Daily reconciliation job**
  (`paypal-subscription-reconciliation`, cron via
  `PAYPAL_SUBSCRIPTION_RECONCILE_CRON`, default `0 3 * * *`): aligns local
  status with PayPal, backfills missed charges by replaying the standard
  payment workflow, and compensates customers who approved but never
  returned to the store - all idempotent.

- **New plugin module** `paypalSubscription` (tables `paypal_plan` and
  `paypal_subscription`, first migrations shipped by the plugin - run
  `medusa db:migrate`). To enable subscriptions, add
  `dependencies: ["paypalSubscription", "order", "product"]` to the payment
  module declaration in medusa-config; without it, existing behavior is
  byte-for-byte unchanged.

### Notes

- The vault off-session renewal path and its contracts are unchanged.
- Sandbox end-to-end checklist for this feature lives in
  `.scratch/paypal-subscriptions/issues/07-sandbox-verification-and-docs.md`.

## [0.3.1] - 2026-09-10

### Fixed

- **vault:** forward `return_url` / `cancel_url` from the checkout session data into `createOrder` — PayPal rejects any order that vaults a payment source with 422 RETURN_URL_REQUIRED / CANCEL_URL_REQUIRED when the approval context lacks them (live-verified on sandbox). URLs ride in the session data; CIT-only, merchant-initiated (vaultId) charges are unaffected.

## [0.3.0]

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
