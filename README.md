# 📝 PayPal Plugin for Medusa

[![npm](https://img.shields.io/badge/npm-@mengyyy369%2Fmedusa--paypal-blue.svg)](https://www.npmjs.com/package/@mengyyy369/medusa-paypal)

A Medusa v2 PayPal payment provider, forked from Alphabite's plugin and extended
with vaulted off-session charging: buyers approve PayPal once at checkout, the
wallet is stored through the PayPal Vault API, and recurring charges (subscription
renewals) run without the buyer present. Also handles one-shot captures, refunds,
and webhook verification.

---

## 🔢 Version Compatibility

Pick the plugin version that matches your Medusa backend version:

| Medusa Version     | Plugin Version | Install Command                                |
| ------------------ | -------------- | ---------------------------------------------- |
| `>= 2.20.*`        | `latest`       | `npm install @mengyyy369/medusa-paypal`        |
| `2.13.* – 2.19.*`  | `0.2.6`        | `npm install @mengyyy369/medusa-paypal@0.2.6`  |
| older / original   | —              | `npm install @alphabite/medusa-paypal`         |

Before installing, verify your Medusa version:

```bash
npm list @medusajs/medusa
```

> ⚠️ Use the same plugin version across local, staging, and production to avoid runtime errors.

---

## 📚 Table of Contents

- [🎯 Core Features](#-core-features)
- [🧱 Compatibility](#-compatibility)
- [🛠 Common Use Cases](#-common-use-cases)
- [📦 Installation](#-installation)
- [🔁 Vaulted Auto-Renewals](#-vaulted-auto-renewals)
- [⭐ PayPal Subscriptions (Billing Plans)](#-paypal-subscriptions-billing-plans)
- [⚙️ Plugin Options](#-plugin-options)
- [🛠 Admin Configuration](#-admin-configuration)
- [📖 Documentation](#-documentation)

---

## 🎯 Core Features

- ✅ Seamless PayPal payment integration
- 🔁 Vaulted auto-renewals: save the buyer's PayPal wallet at checkout and charge it off-session on every billing cycle
- ⭐ Official PayPal Subscriptions: PayPal-hosted recurring billing with automatic retries, buyer self-service, and panel refunds
- 🔄 Handles various PayPal error states
- 💰 Supports refunds directly from Medusa Admin
- 🛒 Creates new order IDs for each payment attempt within the same payment intent
- 📦 Optional inclusion of shipping and customer data in PayPal orders

---

## 🧱 Compatibility

- **Backend:** Medusa v2+
- **Frontend:** Framework-agnostic (integrates with PayPal's SDK)
- **Admin:** Refund functionality integrated into Medusa Admin

---

## 🛠 Common Use Cases

- Accepting PayPal payments for products and services
- Managing payment captures and refunds efficiently
- Ensuring robust payment processing with comprehensive error handling

---

## 📖 Documentation

For complete documentation, visit our [PayPal Plugin Documentation](https://medusa-docs.alphabite.io/docs/category/paypal).

中文从零到生产详细教程:[docs/tutorial.zh-CN.md](./docs/tutorial.zh-CN.md)

---

---

# 📦 Installation

This guide walks you through installing and configuring the Alphabite PayPal Plugin in your Medusa backend.

---

## 1. Install the Plugin

Install the package via npm:

```bash
npm install @mengyyy369/medusa-paypal
```

---

## 2. Register the Plugin

Add the plugin to your `medusa.config.ts` or `medusa-config.js`:

```ts
{
  plugins: [
    {
      resolve: "@mengyyy369/medusa-paypal",
      options: {
        clientId: process.env.PAYPAL_CLIENT_ID,
        clientSecret: process.env.PAYPAL_CLIENT_SECRET,
        isSandbox: process.env.PAYPAL_IS_SANDBOX === "true",
        webhookId: process.env.PAYPAL_WEBHOOK_ID,
        includeShippingData: false,
        includeCustomerData: false,
      },
    },
  ],
  modules:[
    {
      resolve: "@medusajs/medusa/payment",
      options: {
        providers: [
          {
            resolve: "./src/modules/paypal",
            id: "paypal",
            options: {
              clientId: process.env.PAYPAL_CLIENT_ID,
              clientSecret: process.env.PAYPAL_CLIENT_SECRET,
              isSandbox: process.env.PAYPAL_IS_SANDBOX === "true",
              webhookId: process.env.PAYPAL_WEBHOOK_ID,
              includeShippingData: false,
              includeCustomerData: false,
            },
          },
        ],
      },
    },
  ]
};
```

---

## 🔁 Vaulted Auto-Renewals

The provider integrates with subscription engines such as
[@mengyyy369/reorder](https://github.com/MengYYY369/reorder): the engine owns the
billing schedule, dunning, and payment-method swaps; this provider supplies the
PayPal rail.

### Checkout (save the wallet)

1. Create the cart payment session with `customer_id` in the session data:

```ts
await paymentModule.createPaymentSession(paymentCollectionId, {
  provider_id: "pp_paypal_paypal",
  data: { customer_id: customer.id },
})
```

2. The provider creates the PayPal order with
   `payment_source.paypal.attributes.vault` (`store_in_vault: "ON_SUCCESS"`,
   usage type `MERCHANT`) associated with that customer id. The buyer approves
   through the PayPal JS SDK or the approval link exposed as
   `data.redirect_url`.
3. After capture the provider stores the PayPal vault token id in the session
   data as `payment_method` — the key a subscription engine reads as the
   reusable payment method reference.
4. Call `POST /store/paypal/account-holder` (authenticated customer) once so
   saved methods can be listed and swapped through Medusa account holders.

### Renewal (charge off-session)

The subscription engine creates each renewal session with
`data: { payment_method: "<vault token id>", off_session: true, confirm: true, capture_method: "automatic" }`.
The provider creates a PayPal order against `payment_source.paypal.vault_id`
and captures it in the same call — no buyer interaction. Declines throw a
Medusa error carrying `decline_code` (for example `INSTRUMENT_DECLINED`) so the
engine's dunning classification can treat it permanently and recover through a
payment-method change instead of a pointless retry.

### No-charge payment-method binding (vault approval)

The checkout path above binds the wallet **during an order capture**, so it can
never produce a vault id for a free trial — a trial has nothing to capture. The
vault-approval flow is a second, independent way to obtain a vault id: the
plugin creates a PayPal Vault v3 setup token, the buyer approves on PayPal, and
the plugin exchanges the approved token for a permanent vault id. **No money
moves at any step.** The resulting vault id is the same kind of value the
checkout path stores as `payment_method`, so it charges through the existing
off-session renewal path. `store_in_vault: ON_SUCCESS` is untouched and stays
the checkout path; the two coexist.

The caller must already have a customer — pass your **merchant-side** customer
id (for example the Medusa customer id). A deterministic 22-character id
derived from it is sent to PayPal as `customer.id` — the merchant-supplied id
PayPal's payment-token list endpoint resolves by — so no PayPal customer needs
to be created first. The merchant id itself is **not** sent to PayPal: PayPal
freezes a customer record's `customer.id` at the first `merchant_customer_id`
association and would ignore the derived id afterwards, and Orders v2 rejects
the two fields together. Tokens minted before 0.9.0 carry a PayPal-generated
`customer.id` instead: they keep charging through the stored vault id, but they
cannot be backfilled and are not listable. `return_url` and `cancel_url` must
be **absolute http(s) URLs**; anything else is rejected with `INVALID_DATA`
before PayPal is called.

```ts
const svc = container.resolve("paypalSubscription")

// 1. Create the setup token and send the buyer to approve_url.
const { setup_token_id, approve_url } = await svc.startVaultApproval({
  customer_id: customer.id, // merchant-side id -> derived 22-char customer.id (never sent to PayPal)
  return_url: "https://shop.example.com/paypal/return",
  cancel_url: "https://shop.example.com/paypal/cancel",
})

// 2. After the buyer returns, exchange the approved token.
const { status, vault_id } = await svc.completeVaultApproval({
  setup_token_id,
})
// While the payer has not approved: only `status` is present, no `vault_id`.
// Once approved: `vault_id` is set and can be stored as `payment_method`.
// `APPROVED`, `VAULTED` and `TOKENIZED` all mean approved-and-exchangeable —
// sandbox reads back `VAULTED`, not `APPROVED`.
```

Consumers that must work with or without this capability detect it by
duck-typing the resolved service (the reorder engine has no dependency on this
package, so it cannot import a constant):

```ts
const svc = container.resolve("paypalSubscription")
const supported =
  typeof svc.startVaultApproval === "function" &&
  typeof svc.completeVaultApproval === "function"
```

The package root also exports `PAYPAL_VAULT_BINDING_CAPABILITY`
(`"vault-binding"`) as documentation of what that duck-type means.

> **Caller-side security note.** The route that accepts `return_url` /
> `cancel_url` must restrict both to the storefront origin, or an attacker can
> redirect the approval back to a host they control. That route lives in the
> reorder engine, not in this package — it is a reorder-repo follow-up and is
> **not** addressed by this release.

### PayPal account requirements

Vaulting is gated on the PayPal account and application:

1. Reference-transaction approval — contact your PayPal account manager.
2. The account eligibility review under Account Settings → Payment preferences →
   "Save PayPal and Venmo payment methods".
3. The "Save payment methods" feature toggle for the REST application in the
   PayPal Developer Dashboard. Enable it for the sandbox application too, or
   vault tests fail.
4. RDA (risk data) is mandatory on customer-approved flows; collect it through
   the official PayPal JS SDK.

> These gates **cannot be verified without production access**. A sandbox
> application without the "Save payment methods" feature fails the direct vault
> calls (the vault-approval flow above) with a bare `403 NOT_AUTHORIZED`.
> Order-time `store_in_vault: ON_SUCCESS` vaulting can still work on such an
> application, so the two vault paths are gated separately.

---

## ⭐ PayPal Subscriptions (Billing Plans)

Besides the vault path, the plugin can run **official PayPal Subscriptions**
(Billing Subscriptions API): the buyer approves once on PayPal, PayPal charges
every period, retries failed charges per its own policy, and buyers can manage
(see/cancel) the subscription inside their PayPal account. Both paths coexist -
variants without subscription metadata behave exactly as before.

### 1. Mark a variant as a subscription

Set the `paypal_subscription` metadata key on the **variant**:

```json
{
  "interval_unit": "MONTH",
  "interval_count": 1,
  "trial_periods": [{ "unit": "DAY", "count": 7, "price": 0 }],
  "setup_fee": 100
}
```

| Field            | Required | Meaning                                                                                       |
| ---------------- | -------- | --------------------------------------------------------------------------------------------- |
| `interval_unit`  | yes      | `DAY`, `WEEK`, `MONTH`, or `YEAR`                                                              |
| `interval_count` | no       | Billing every N units (default `1`)                                                            |
| `trial_periods`  | no       | One trial period (unit/count, `price` in minor units; `0` = free trial)                        |
| `setup_fee`      | no       | One-time fee in minor units, charged at approval                                               |
| `product_type`   | no       | PayPal product type: `SERVICE` (default), `PHYSICAL`, `DIGITAL`                                |

The **price is not declared** - it comes from the variant's live price for the
checkout currency. Only fixed-price subscriptions are supported (usage-based
billing stays on the vault path).

### 2. Enable subscription modules

Add one `dependencies` line to the payment module declaration, next to the
provider you already registered:

```js
{
  resolve: "@medusajs/medusa/payment",
  dependencies: ["paypalSubscription", "order", "product", "query"], // ← enables subscriptions
  options: { providers: [/* your paypal provider */] },
}
```

The plugin ships a small `paypalSubscription` module (four tables:
`paypal_plan`, `paypal_subscription`, `paypal_settings`,
`paypal_settings_audit`) that is registered automatically - just
run `medusa db:migrate` after installing. Without this line nothing changes:
regular and vault checkouts are untouched.

### 3. Configure the subscription webhook

Create a **second webhook** in the PayPal developer dashboard (in addition to
your existing payment webhook) and point it at:

```
https://<your-backend>/hooks/paypal/subscriptions
```

Subscribe it to these event types only:

- `BILLING.SUBSCRIPTION.ACTIVATED`
- `BILLING.SUBSCRIPTION.SUSPENDED`
- `BILLING.SUBSCRIPTION.CANCELLED`
- `BILLING.SUBSCRIPTION.EXPIRED`
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED` (verify the exact type in sandbox; `PAYMENT.SALE.DENIED` and `PAYMENT.SALE.DECLINED` are also handled - tick them too)
- `PAYMENT.SALE.COMPLETED`
- `PAYMENT.SALE.REFUNDED` / `PAYMENT.SALE.REVERSED` (fallback; see refunds below)

**Do not** subscribe this webhook to `PAYMENT.CAPTURE.*` - those events belong
to the standard Medusa payment webhook and would be delivered twice. (The
plugin ignores any `PAYMENT.CAPTURE.*` delivered here, so a stray checkbox is
harmless.)

> **Note on the standard payment webhook:** point it at
> `https://<your-backend>/hooks/payment/<registration-key-minus-pp_>`.
> Medusa's payment module registers every provider as `pp_` + the provider
> identifier + (`_` + the entry's `id` when the config sets one), and when a
> webhook event is dispatched the module prepends `pp_` to the path segment -
> so the segment is that key **without** the leading `pp_`. Concretely: with no
> `id` in the provider entry the key is `pp_paypal` and the URL ends in
> `/hooks/payment/paypal`; **with the `id: "paypal"` this README's own options
> example uses, the key is `pp_paypal_paypal` and the URL ends in
> `/hooks/payment/paypal_paypal`.** Check the key your host registers before
> pasting the URL: the route answers 200 either way, so a wrong segment is
> invisible to PayPal's dashboard and only surfaces in the backend logs as a
> provider-resolution error.
>
> Subscribe it to the capture-class events the provider maps:
>
> - `PAYMENT.CAPTURE.COMPLETED` - the captured mechanism; also the
>   first-period charge of a subscription.
> - `PAYMENT.CAPTURE.DECLINED` - declines, surfaced as a failed webhook action. (The provider maps `PAYMENT.CAPTURE.DECLINED`, not `DENIED`.)
> - `PAYMENT.CAPTURE.REFUNDED` and `PAYMENT.CAPTURE.REVERSED` - **required**:
>   these are the events PayPal actually fires for panel refunds of
>   subscription charges, and they drive the refund sync (`PAYMENT.SALE.REFUNDED`
>   is not emitted for them).
>
> Everything else in `PAYMENT.CAPTURE.*` maps to `not_supported`, so ticking
> more is harmless but unnecessary. Do not tick `BILLING.SUBSCRIPTION.*` or
> `PAYMENT.SALE.*` here - they belong to the subscription webhook below.

Then pass its webhook id as `subscriptionWebhookId` (falls back to
`webhookId` when omitted). Signature verification tries both ids, so even a
single-webhook setup where everything is delivered to the standard endpoint
keeps working.

### 4. First purchase

Both approval paths are supported and need **no storefront changes**:

- **Redirect**: `initiatePayment` detects subscription items, creates the
  PayPal subscription, and exposes the approval link as `redirect_url` in the
  session data (`return_url` / `cancel_url` are forwarded from the session
  data). Mixing subscription items with regular items in one cart is rejected
  with a clear error - place subscriptions separately, one per order.
- **Buttons (JS SDK)**: call
  `POST /store/paypal/subscriptions` with `{ "session_id": "<payment session id>" }`
  from the `createSubscription` callback. The route is an idempotent
  get-or-create and returns `{ subscription: { id } }` for the SDK.

The first order is created by the standard cart completion. The activation
trigger is `BILLING.SUBSCRIPTION.ACTIVATED`; the first charge (setup fee or
full price) arrives as `PAYMENT.SALE.COMPLETED` and flows through the standard
captured mechanism. Customers who approve but never return to the store are
covered: the standard workflow completes their cart from the webhook, and the
daily reconciliation job backfills anything lost.

**First-period amount semantics**: the cart total equals the full recurring
price, but with a trial/setup fee PayPal charges only the setup fee (or `0`)
up front. The order therefore shows a partial capture until the first regular
charge; the actually-charged amount and currency ride on the
`paypal.subscription.*` events.

### 5. Renewals, refunds, lifecycle

- **Renewals**: every later `PAYMENT.SALE.COMPLETED` creates a renewal Medusa
  order automatically - same customer, first-order items at locked prices,
  the PayPal sale id stored as the refund anchor.
- **Refunds, both directions**: panel refunds of subscription charges fire
  `PAYMENT.CAPTURE.REFUNDED` / `REVERSED` on the standard payment webhook -
  the plugin's built-in subscriber syncs them into Medusa refunds on the
  matching order (the refund's `custom` field carries the payment session id,
  so full and partial refunds are both recorded). Medusa Admin refunds on
  subscription orders refund the PayPal capture through the provider.
  `PAYMENT.SALE.REFUNDED` / `REVERSED` (legacy billing-agreement shape) are
  handled as a fallback.
- **Admin API** (auth handled by the global admin middleware):
  - `GET /admin/paypal/subscriptions?status=ACTIVE&customer_id=&variant_id=&limit=&offset=`
  - `GET /admin/paypal/subscriptions/:id`
  - `POST /admin/paypal/subscriptions/:id/actions` with `{ "action": "cancel" | "suspend" | "resume" }`
  - `POST /admin/paypal/plans/sync` with `{ "variant_id", "currency_code" }` - pre-create or inspect the cached plan
- **Admin UI** (ships with the package, no extra setup): the Medusa admin
  sidebar shows a **PayPal** entry (the configuration page at `/paypal`) with
  **PayPal Subscriptions** (`/paypal/subscriptions`; details at
  `/paypal/subscriptions/:id`) and **Audit log** (`/paypal/audit`) as its
  children. Every extension page follows the language the admin user picked in
  their dashboard profile - the plugin ships no language switcher of its own.
  After updating the plugin, rebuild the host admin - `medusa build` or restart
  `medusa develop`. The old `/paypal-subscriptions*` URLs no longer exist.
  - **List page**: filter by status (chips for `APPROVAL_PENDING` / `ACTIVE` /
    `SUSPENDED` / `CANCELLED` / `EXPIRED`), paginate (newest first), and scan
    key columns - PayPal subscription id, status badge, customer email,
    product/variant title, locked amount + currency, billing period, next
    billing date, failure count. Customer and product names are resolved from
    the core admin APIs; if those lookups fail the raw ids are shown instead.
  - **Detail page**: full fields including PayPal plan id, payment session,
    and sales/refund history, plus the lifecycle actions:
    - **Suspend / Resume** - reversible; a plain confirmation dialog.
    - **Cancel subscription** - a strong red confirmation warning that the
      action is **irreversible** (PayPal terminates the billing agreement
      immediately; the customer keeps entitlements for periods already paid).
      Use Suspend for a temporary stop.
  - Amounts are shown in Medusa major units (the locked recurring price, not
    the current catalog price). Rejections from PayPal (e.g. a status that
    does not allow the action) surface their actual reason in the UI.
  - The interface switches between English and Chinese automatically (it
    follows the admin's language setting or the browser language), and the
    list page has a manual `EN | 中文` toggle.
- **Customer self-service** (customer auth):
  - `GET /store/paypal/subscriptions` - own subscriptions
  - `POST /store/paypal/subscriptions/:id/cancel` - cancel own subscription
- **Events** on the Medusa event bus: `paypal.subscription.activated`,
  `paypal.subscription.suspended`, `paypal.subscription.resumed`,
  `paypal.subscription.cancelled`, `paypal.subscription.expired`,
  `paypal.subscription.payment_succeeded`, `paypal.subscription.payment_failed`.
- **Cancellation semantics** are PayPal's: future charges stop immediately,
  paid periods keep their entitlements until period end.
- **Reconciliation**: a daily job (cron overridable via
  `PAYPAL_SUBSCRIPTION_RECONCILE_CRON`, default `0 3 * * *`) aligns local
  status with PayPal and backfills missed sales / never-completed first
  purchases idempotently.

> **Note:** your PayPal business account needs the Subscriptions capability
> enabled (verify in sandbox first - it is the first item of the release
> checklist).

### 6. Item contract for purchase units

The items of the checkout (`session.data.items[]`) are mapped onto PayPal
purchase-unit items. The contract:

| Field        | Type     | Required | Source                          |
| ------------ | -------- | -------- | ------------------------------- |
| `title`      | `string` | yes      | `item.title`                    |
| `unit_price` | `number` | yes      | `item.unit_price` (major units) |
| `quantity`   | `number` | yes      | `item.quantity`                 |

All amounts are Medusa major units. They are formatted for PayPal with the
currency's own `decimal_digits` as reported by the currency module (`usd` →
`9.99`, `jpy` → `1000`); the plugin never rescales a number.

A missing `title` or `unit_price` is rejected with a clear error naming the
missing field, not a generic 500 — every item in the session must carry both,
or the payment session will not be created.

A valid item:

```json
{ "title": "Pro Plan - Monthly", "unit_price": 9.99, "quantity": 1 }
```

---

## ⚙️ Plugin Options

The following options can be passed to the PayPal plugin in your `medusa-config.js` or `medusa.config.ts` file:

| Option                | Type      | Default | Description                                                                                     |
| --------------------- | --------- | ------- | ----------------------------------------------------------------------------------------------- |
| `clientId`            | `string`  |         | Optional. Your PayPal API client ID. Omit both credentials to configure from the admin settings page. |
| `clientSecret`        | `string`  |         | Optional. Your PayPal API client secret. Omit both credentials to configure from the admin settings page. |
| `isSandbox`           | `boolean` | `false` | Whether to use the PayPal Sandbox environment for testing.                                      |
| `webhookId`           | `string`  |         | Optional. Your PayPal webhook ID. If provided, enables confirmation of payment captures.        |
| `subscriptionWebhookId` | `string` |        | Optional. Webhook ID of the second (subscription) webhook; falls back to `webhookId`.           |
| `includeShippingData` | `boolean` | `false` | Optional. If `true`, shipping data from the storefront order will be added to the PayPal order. |
| `includeCustomerData` | `boolean` | `false` | Optional. If `true`, customer data from the storefront order will be added to the PayPal order. |
| `autoBillOutstanding` | `boolean` | `true`  | Optional. Subscription plan payment preference: bill outstanding balances automatically.        |
| `paymentFailureThreshold` | `number` | `3`  | Optional. Subscription plan payment preference: failed attempts before PayPal suspends.         |

**Configuration layers**: as of 0.7.0 the plugin reads configuration from
exactly two layers — the `medusa-config` options above and the admin settings
page (runtime overrides stored in the plugin's database tables). There is no
environment-variable fallback: an option you do not set in `medusa-config`
either comes from the admin settings row or stays unset. The admin layer wins
field by field; see [Admin Configuration](#-admin-configuration) below.

> **Vault binding and the environment.** The vault-binding flow builds its
> client from the module's own chain: the admin settings row first, then the
> plugin `options` above. The payment provider's `providerOptions` are *not*
> visible to it (the module declares no dependencies, so its local container
> cannot reach the payment module), so register the plugin with
> `options: { isSandbox }` — a bare-string registration leaves that last layer
> empty, and a null `is_sandbox` row then silently builds a **live** client
> while the storefront still reports sandbox. Since 0.9.2 a fully unset
> environment logs one warning instead of staying silent.

---

## 🛠 Admin Configuration

The Medusa admin sidebar has a **PayPal** entry that opens the configuration
page at `/paypal`. The page edits the nine provider options in four groups
(credentials / environment / webhooks / advanced), shows read-only integration
info (both webhook callback URLs, the reconciliation cron, the last change and
the last credential check) and each field's inheritance source. Its two child
entries are **PayPal Subscriptions** (`/paypal/subscriptions`, details at
`/paypal/subscriptions/:id`) - the subscription list that used to live at
`/paypal-subscriptions` - and **Audit log** (`/paypal/audit`), the field-level
change trail (who / when / which fields / old → new, with secrets masked to
their last 4 characters). The old `/paypal-subscriptions*` URLs are gone and
return 404 — update bookmarks. All three pages are bilingual and follow the
language the admin user selects in their dashboard profile.

### Upgrading to 0.7.0

Run the plugin's migrations once after installing the new version:

```bash
npx medusa db:migrate
```

This creates `paypal_settings` (the single row of admin overrides) and
`paypal_settings_audit` (the field-level change history) inside the existing
`paypalSubscription` module. Until the migration has run, reads degrade with a
warning and keep using the `medusa-config` values (payments do not break), but
saving from the admin page fails with a clear error: HTTP 400 naming the
missing `paypal_settings` table and telling you to run `npx medusa db:migrate`.

### Inheritance and hot reload

Each field is resolved independently, in this order:

```
admin settings (DB) -> payment provider options -> plugins[].options
```

A field with no admin override inherits from `medusa-config`, and the settings
page shows which layer currently provides each value. Clearing a field in the
admin removes the override and restores inheritance. Changes take effect
immediately — no restart and no rebuild — because the plugin re-resolves the
configuration on every operation and rebuilds its PayPal client and
subscription engine when the stored settings version changes.

`clientId` and `clientSecret` are optional at boot: with neither set the plugin
starts with a warning and stays unconfigured until you fill them in on the
settings page; with exactly one set it refuses to start (a typo guard). Any
PayPal call without credentials now fails with a clear "PayPal is not
configured" error instead of a PayPal 401.

### Connection test

The page's **test connection** button and its post-save automatic check call
`POST /admin/paypal/settings/verify` (the route directory is `verify`, not
`test`: the plugin compiler prunes any path containing a `test` segment). An
empty body tests the stored configuration and records the outcome as the last
credential check; draft `clientId` / `clientSecret` / `isSandbox` values in the
body test those overrides without touching the saved row. The endpoint answers
`{ ok, environment, error?, durationMs }` and never echoes the secret.

### Escape hatch

If a bad admin configuration breaks payments, set `PAYPAL_IGNORE_DB_SETTINGS`
to a truthy value (`1`, `true`, `yes`, `on`) and restart the container. The
resolver then ignores the database layer entirely and behaves as if no override
existed — i.e. exactly the `medusa-config` state from before the admin edit.
Unset it to re-enable the overrides.

### Storefront runtime config

`GET /store/paypal/config` is a read-only endpoint that returns the effective
configuration without calling PayPal:

```json
{ "client_id": "AaBbCc...", "environment": "sandbox", "configured": true }
```

`environment` is `"sandbox"` or `"production"`. When the credentials are
missing it still answers HTTP 200 with `client_id: null` and
`configured: false` — unconfigured is a normal state, not an error. The
response carries `Cache-Control: no-store`, and like every `/store` route it
requires the host's publishable key (but no customer authentication).

A storefront can fetch this endpoint at runtime and pass `client_id` and
`environment` to `PayPalScriptProvider`; because `@paypal/react-paypal-js`
reads its options only at mount, fetch the config first and mount the provider
afterwards (or remount it with a `key`). This removes the need for a build-time
`NEXT_PUBLIC_PAYPAL_CLIENT_ID` and keeps the checkout buttons in sync with
whatever environment and client id the admin page currently holds — no
storefront rebuild required.

---

## ✅ Compatibility

- Requires **Medusa v2**
- Compatible with both JS and TypeScript projects

---

## 🚀 Next Steps

👉 [Configuration Guide](https://medusa-docs.alphabite.io/docs/category/paypal)
👉 [Join our Discord Community](https://discord.gg/ZgBCYTMaVQ) for faster support

---

## 💻 Front End Integration

This guide explains how to integrate the PayPal payment flow into your Next.js storefront using `@paypal/react-paypal-js`.

### 1. Install Dependencies

Install the official PayPal React SDK:

```bash
npm install @paypal/react-paypal-js
```

### 2. Environment Variables

Ensure your public PayPal Client ID is available in your environment variables:

```env
NEXT_PUBLIC_PAYPAL_CLIENT_ID=your_paypal_client_id
```

### 3. Implementation Overview

The integration involves wrapping your payment form with `PayPalScriptProvider` and `PayPalCardFieldsProvider`.

#### Key Components:

- **`PayPalScriptProvider`**: Loads the PayPal SDK script.
- **`PayPalCardFieldsProvider`**: Manages the state and callbacks for the card fields.
- **`PayPalCardFieldsForm`**: Renders the secure input fields.

### 4. Code Example

Here is a simplified structure of how to implement the PayPal payment component, based on `shose-storefront/src/collections/form/checkout/paypal.tsx`:

```tsx
import {
  PayPalCardFieldsForm,
  PayPalCardFieldsProvider,
  PayPalScriptProvider,
  usePayPalCardFields,
} from "@paypal/react-paypal-js";
import { useState, useEffect } from "react";
// Import your internal hooks/utilities (e.g., sdk, usePlaceOrder)

export const PayPalPayment = ({ cart, onPaymentCompleted }) => {
  const [clientToken, setClientToken] = useState(null);

  // 1. Fetch Client Token from your backend
  useEffect(() => {
    const fetchClientToken = async () => {
      const response = await sdk.client.fetch("/store/paypal/client-token", {
        method: "POST",
      });
      setClientToken(response.client_token);
    };
    fetchClientToken();
  }, []);

  // 2. Define Callbacks
  const createOrder = async () => {
    // Logic to initiate payment session and return order_id
    // e.g., sdk.store.payment.initiatePaymentSession(cart, { provider_id: "pp_paypal_paypal" })
    return order_id;
  };

  const onApprove = async (data) => {
    // Logic to finalize order after PayPal approval
    await placeOrder();
    onPaymentCompleted();
  };

  if (!clientToken) return <div>Loading...</div>;

  return (
    <PayPalScriptProvider
      options={{
        clientId: process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID,
        components: "card-fields",
        currency: "EUR",
        intent: "capture",
        dataClientToken: clientToken,
      }}
    >
      <PayPalCardFieldsProvider
        createOrder={createOrder}
        onApprove={onApprove}
        style={{
          input: {
            "font-size": "14px",
            "font-family": "Inter, sans-serif",
            color: "#111827",
          },
        }}
      >
        <PayPalCardFieldsForm />
        <SubmitButton />
      </PayPalCardFieldsProvider>
    </PayPalScriptProvider>
  );
};

const SubmitButton = () => {
  const { cardFieldsForm } = usePayPalCardFields();

  const handleClick = async () => {
    if (cardFieldsForm) {
      await cardFieldsForm.submit();
    }
  };

  return <button onClick={handleClick}>Pay Now</button>;
};
```

### 5. Payment Flow Details

1.  **Client Token**: You **must** fetch a client token from your Medusa backend (`/store/paypal/client-token`) and pass it to `PayPalScriptProvider`. This authorizes the client to perform actions on behalf of your account.
2.  **Create Order**: The `createOrder` callback is triggered when the user attempts to pay. It should initialize a payment session in Medusa and return the PayPal Order ID.
3.  **On Approve**: The `onApprove` callback runs after PayPal successfully authorizes the payment. Use this to complete the order in Medusa (e.g., `placeOrder`).
