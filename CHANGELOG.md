# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.7.1] - 2026-09-29

### Changed

- **The admin extension now uses the dashboard's own i18n.** Page copy is
  translated through the admin's `react-i18next` instance (namespace `paypal`),
  so it follows the language each admin user selects in their profile. The
  plugin's own `EN | 中文` toggle, its `paypal_admin_lang` localStorage override
  and its language-detection chain are gone. `react-i18next@13.5.0` is pinned as
  a peer dependency - the import must resolve to the instance
  `@medusajs/dashboard` initialises, otherwise every `t()` returns raw keys.
- **"Change history" is now "Audit log" on its own page.** The collapsible
  section at the bottom of `/paypal` moved to a new sidebar child
  `/paypal/audit`, which lists 50 entries by default with a **Load more** button
  (the endpoint caps `limit` at 100) and a refresh button.

### Added

- **`/paypal/audit` admin route** - the field-level audit trail (actor,
  timestamp, `old → new` per field, secrets masked to their last 4 characters).

### Notes

- Upgrading from 0.7.0 needs **no** database migration.
- Admin URLs are unchanged; only a new child route was added under `/paypal`.

## [0.7.0] - 2026-09-29

### Added

- **Admin configuration page** at `/paypal`: the sidebar now has a **PayPal**
  parent entry whose page edits the nine provider options in four groups
  (credentials / environment / webhooks / advanced), shows read-only
  integration info (both webhook callback URLs, the reconciliation cron, the
  last change and the last credential check) and the last 20 field-level audit
  entries. Inherited fields render the `medusa-config` value as a grey
  placeholder plus a badge naming the source layer, and clearing a field
  restores inheritance. `clientSecret` is never returned by the API - only
  `hasSecret` and its last 4 characters. Saving runs an automatic connection
  test (fire-and-forget: it never blocks or rolls back the save) and a
  separate button tests draft values; the result is stored and shown.
- **Settings storage**: `paypal_settings` (singleton row of nullable
  field-level overrides plus a `version` that increments on every write) and
  `paypal_settings_audit` (per-write `{ field: { from, to } }` diff, secret
  values masked), created inside the existing `paypalSubscription` module.
  **Upgrading requires `npx medusa db:migrate`.** Until the migration runs,
  reads degrade with a warning and keep using the `medusa-config` values
  (payments do not break), while saves fail with a clear error.
- **Runtime config endpoint** `GET /store/paypal/config` ->
  `{ client_id, environment, configured }`: read-only, never calls PayPal,
  `Cache-Control: no-store`, scoped by the host publishable key like every
  `/store` route and requiring no customer authentication. Unconfigured answers
  200 with `client_id: null` / `configured: false`, so a storefront can render
  a disabled state; storefronts can read the client id and environment at
  runtime instead of baking `NEXT_PUBLIC_PAYPAL_CLIENT_ID` in at build time.
- **Hot reload**: a single resolver (per-field merge, keyed on the settings row
  version) is now the only configuration source, and the provider and module
  rebuild their PayPal client / subscription engine when the version or the
  resolved values change. Admin edits take effect immediately, with no
  restart.
- **Ops escape hatch** `PAYPAL_IGNORE_DB_SETTINGS` (truthy values `1`, `true`,
  `yes`, `on`): the resolver skips the DB layer entirely, so restarting the
  container with it set rolls back to the `medusa-config` state from before
  the admin edit.

### Changed

- **Configuration resolution is now per-field
  `admin settings (DB) -> payment provider options -> plugins[].options`**.
  An unset admin field inherits from the next layer, preserving both existing
  config surfaces unchanged; clearing a field removes its override.
- **`clientId` / `clientSecret` are optional at boot**: with neither set the
  plugin starts with a warning and can be configured from the admin page; with
  exactly one set it still refuses to start (typo guard). Every PayPal call
  without credentials now throws a clear "PayPal is not configured" error
  instead of a PayPal 401.
- **The module-side default environment converges to production**
  (`isSandbox: false`) when no layer sets it, matching the provider schema;
  the `paypalSubscription` module previously defaulted to sandbox. The
  client-token route derives its environment and REST base from the resolved
  config instead of `process.env.PAYPAL_SANDBOX`.
- **The plan cache hash now includes the environment** (`planConfigHash`), so
  a plan minted in sandbox is not reused in live. **Upgrade side effect**: the
  first checkout after upgrading mints one new plan per variant + currency in
  the current environment (the existing rows' hashes no longer match).
  Existing subscriptions keep their old plan and renew normally.
- **The sidebar label follows the dashboard language** (absorbed from the
  unreleased 0.6.2): the route configs declare `translationNs` and
  `src/admin/i18n/index.ts` registers the plugin's `paypal` namespace
  (`virtual:medusa/i18n`), so the sidebar shows "PayPal Subscriptions" in
  English and "PayPal 订阅" in Chinese. The English value is a byte-for-byte
  copy of the previous label.

### Fixed

- **The plugin no longer ships the never-loaded `src/api/middleware.ts`**
  (singular): the framework's middleware loader only probes `middlewares.ts` /
  `middlewares.js`, so the file was dead code. It is now
  `src/api/middlewares.ts`; besides hosting the new settings API validation,
  the rename restores `preserveRawBody: true` for
  `POST /hooks/paypal/subscriptions`, so the emitted `WebhookReceived` payload
  carries `rawData` like the standard payment webhook (signature verification
  was unaffected).
- **The connection-test endpoint actually reaches the build**: it is now
  `POST /admin/paypal/settings/verify`, renamed from
  `POST /admin/paypal/settings/test`. The framework's plugin compiler prunes
  any path containing a `test` segment
  (`_Compiler_backendIgnoreFiles`), so the old route was silently dropped from
  `.medusa/server` and every host answered 404 - the page's test button and
  the post-save auto-verification were dead, and `lastVerified*` could never
  be written. The handler behaviour is unchanged; the admin page, the
  middleware validator and the docs were updated to the new URL.
- **A missing `paypal_settings` table now fails the write readably**: saving
  settings (or recording a verification) before `npx medusa db:migrate` used
  to answer the framework's generic `500 {"code":"unknown_error"}` while only
  the log held the real `relation "paypal_settings" does not exist`. The write
  path now translates exactly that failure into a `400 invalid_data` naming
  the table and telling the operator to run `npx medusa db:migrate`; every
  other error still propagates unchanged, and the read path keeps degrading
  silently as before.
- **`POST /store/paypal/client-token` no longer 404s on hosts that register
  the provider without an explicit `id`**: it looked the provider up with an
  inline `provider.id === "paypal"` check, so a declaration keyed as
  `pp_paypal` (the common case - no `id` in `medusa-config`) answered
  `404 {"error":"Paypal provider not found"}`. It now uses the shared
  `findPaypalProviderDeclaration` lookup (which also accepts
  `resolve.includes("paypal")`) like every other consumer. This is a
  pre-existing defect, not a 0.7.0 regression.

### Breaking

- **Admin URLs moved**: subscriptions are now at `/paypal/subscriptions` and
  `/paypal/subscriptions/:id`; the old `/paypal-subscriptions*` URLs return
  404. Update bookmarks and hard-coded admin links.
- **Deployments must run `npx medusa db:migrate`**: without it the admin
  settings page cannot save, and settings reads log a warning while payments
  continue on the `medusa-config` values.

## [0.6.1] - 2026-09-27

### Fixed

- **Admin extension pages no longer 401**: the plugin's admin SDK client did
  not declare an auth type, so js-sdk sent every extension-page request with
  `credentials: "omit"` and no Bearer header - while the dashboard
  authenticates via the `/auth/session` cookie and never writes a JWT to
  localStorage, leaving those requests with no credentials at all. The client
  now declares `auth: { type: "session" }` (mirroring the dashboard's own
  js-sdk setup), so requests carry the session cookie, and a 401 surfaces as
  a friendly "session expired" message instead of a raw `Unauthorized`.

### Changed

- **Customer / product enrichment now takes effect**: the list and detail
  pages resolve customer emails and product/variant titles through the same
  SDK client, so with the auth fixed those columns show real emails and
  titles instead of raw ids - a visible change of the 0.6.0 enrichment, not a
  regression.

### Added

- **Chinese UI**: the admin extension pages now carry an English / Chinese
  dictionary. The language follows the dashboard's language setting or the
  browser language, and the subscription list page has a manual `EN | 中文`
  toggle (persisted in localStorage); the sidebar label stays English.

## [0.6.0] - 2026-09-27

### Added

- **Admin UI for PayPal subscriptions**: a built-in Medusa admin extension —
  sidebar entry "PayPal Subscriptions", a filterable/paginated subscription
  list (status chips for the full local status vocabulary, customer email and
  product/variant titles enriched client-side with graceful fallback to raw
  ids, major-unit amounts with currency, billing period, next billing date,
  failure count) and a detail page (all fields incl. PayPal plan id, payment
  session, sales/refund history) with suspend / resume / cancel actions.
  Cancel carries a strong red confirmation stating the action is irreversible
  (PayPal terminates the billing agreement); suspend/resume are reversible.
  Shipped as part of the npm package — no extra configuration. UI copy is
  English; no new runtime dependencies (`@medusajs/js-sdk` added as a
  devDependency for the bundled extension only).

### Changed

- Admin subscription list API now sorts by `created_at DESC` by default:
  offset pagination previously had no stable ordering, so concurrent webhook
  writes could shuffle rows across pages (duplicates / dropped rows).

### Fixed

- Admin lifecycle actions (`cancel` / `suspend` / `resume`) no longer surface
  PayPal rejections as opaque 500s: rejections are wrapped in a Medusa
  `invalid_data` error (`code: "paypal_rejected"`) whose message carries the
  HTTP status and PayPal issue, so the admin UI (and any API client) can show
  the actual rejection reason. State-class no-ops still converge to success
  idempotently (unchanged).

## [Unreleased]

_以下条目来自 2026-09-21/22 源码审查工单（`.scratch/source-repo-fixes/issues` #01–#07），**代码尚未实现**，读到这里请勿当作已交付行为。_

### Fixed (planned #01–#04)

- **deletePayment** no longer throws for subscription-type sessions (the PayPal
  billing subscription is cancelled with an "Abandoned checkout" note, and
  `404 INVALID_RESOURCE_ID` is swallowed as expected) or for sessions that never
  created a PayPal order (`CANCELED` stub) — switching between payment tracks no
  longer produces a 500. (Note: `Could not delete all payment sessions` is
  Medusa core's wrapper text; the plugin's own throw is the missing-`data.id` one.)
- **credential fallback**: the service constructor falls back to
  `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_IS_SANDBOX` /
  `PAYPAL_WEBHOOK_ID` / `PAYPAL_SUBSCRIPTION_WEBHOOK_ID` when options are
  missing (explicit options win when both are present). A
  `resolvePaypalProviderConfig` helper serves the four sites that construct the
  service outside the provider container.
- **approve link**: vaulted checkouts that receive `payer-action` instead of
  `approve` are now matched (both in `initiatePayment` and in
  `initiateSubscriptionSession`), eliminating the silently-missing
  `redirect_url`; the raw `links` are kept in the session data for storefronts.
- **item contract**: missing `title` / `unit_price` (and non-numeric `quantity`)
  raise a clear `INVALID_DATA` error naming the field instead of a generic 500.

### Changed (planned #05)

- **Dependencies**: `@mikro-orm/*` dev and peer dependencies from 6.4.3 to
  exactly 6.6.14 to match the version embedded in Medusa 2.20, eliminating the
  duplicate-copy `improper qualified name (too many dotted names)` cart 500.
  **Not yet done — this release still declares 6.4.3.**

### Added (planned #07)

- Switch subscription in place via PayPal `POST /v1/billing/subscriptions/{id}/revise`
  (same-product plan/frequency change, no cancel-then-resubscribe), a
  `paypal.subscription.revised` event, and an R5 guard rejecting a second active
  native subscription for the same customer × product.

## [0.5.0] - 2026-09-22

### Changed — BREAKING: money units

- All amounts handed to PayPal are now **Medusa major units** (e.g. `9.99`),
  formatted with the currency's own `decimal_digits` instead of a hard-coded
  `/100`. The provider no longer rescales in either direction: the outbound
  `÷100` (order total, purchase-unit amount, plan price/trial/setup fee,
  refund) and the inbound `×100` (webhook capture/refund amounts) are gone, and
  `toPaypalMajorAmount`/`toMajorUnits` are replaced by
  `formatPaypalAmount(major, fractionDigits)` with
  `src/lib/currency-digits.ts` resolving digits via the currency module
  (falls back to 2 with a warning).
- **Deployment coupling**: this version must ship in the same window as the
  data migration `medusa-saas/scripts/money-minor-to-major.sql`. A deployment
  that stores amounts in minor units (cents/fen) while running this code charges
  **100× too much**; applying the SQL without this code charges 100× too little.
  Verify one real order three ways before and after: PayPal charge = admin order
  total = storefront display.
- Compatibility is unchanged here: the package still declares
  `@mikro-orm/*` **6.4.3** peers (the 6.6.14 alignment is still unreleased, see
  `[Unreleased]`), and requires Medusa 2.20.

### Fixed

- Webhook-derived capture/refund amounts are no longer inflated by 100, so
  recorded payments match the money PayPal actually moved.

### Dependencies

- `react` / `react-dom` added to `peerDependencies` (`^18.2.0`): admin bundles
  that resolve a second React copy break the dashboard, so resolution is left to
  the host app.

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
