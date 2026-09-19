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
              isSandbox: process.env.PAYPAL_SANDBOX === "true",
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

The plugin ships a small `paypalSubscription` module (two tables:
`paypal_plan`, `paypal_subscription`) that is registered automatically - just
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
- `BILLING.SUBSCRIPTION.PAYMENT.FAILED` (verify the exact type in sandbox; `PAYMENT.SALE.DENIED` is also handled)
- `PAYMENT.SALE.COMPLETED`
- `PAYMENT.SALE.REFUNDED` / `PAYMENT.SALE.REVERSED` (fallback; see refunds below)

**Do not** subscribe this webhook to `PAYMENT.CAPTURE.*` - those events belong
to the standard Medusa payment webhook and would be delivered twice. (The
plugin ignores any `PAYMENT.CAPTURE.*` delivered here, so a stray checkbox is
harmless.)

> **Note on the standard payment webhook:** point it at
> `https://<your-backend>/hooks/payment/paypal` (the path segment is the
> provider id **without** the `pp_` prefix - Medusa prepends it internally)
> and make sure `PAYMENT.CAPTURE.REFUNDED` + `PAYMENT.CAPTURE.REVERSED` are
> subscribed there: they are the events PayPal actually fires for panel
> refunds of subscription charges, and they drive the refund sync.

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

---

## ⚙️ Plugin Options

The following options can be passed to the PayPal plugin in your `medusa-config.js` or `medusa.config.ts` file:

| Option                | Type      | Default | Description                                                                                     |
| --------------------- | --------- | ------- | ----------------------------------------------------------------------------------------------- |
| `clientId`            | `string`  |         | Required. Your PayPal API client ID.                                                            |
| `clientSecret`        | `string`  |         | Required. Your PayPal API client secret.                                                        |
| `isSandbox`           | `boolean` | `true`  | Whether to use the PayPal Sandbox environment for testing.                                      |
| `webhookId`           | `string`  |         | Optional. Your PayPal webhook ID. If provided, enables confirmation of payment captures.        |
| `subscriptionWebhookId` | `string` |        | Optional. Webhook ID of the second (subscription) webhook; falls back to `webhookId`.           |
| `includeShippingData` | `boolean` | `false` | Optional. If `true`, shipping data from the storefront order will be added to the PayPal order. |
| `includeCustomerData` | `boolean` | `false` | Optional. If `true`, customer data from the storefront order will be added to the PayPal order. |
| `autoBillOutstanding` | `boolean` | `true`  | Optional. Subscription plan payment preference: bill outstanding balances automatically.        |
| `paymentFailureThreshold` | `number` | `3`  | Optional. Subscription plan payment preference: failed attempts before PayPal suspends.         |

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
      setClientToken(response.clientToken);
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
