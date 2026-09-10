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
- [⚙️ Plugin Options](#-plugin-options)
- [📖 Documentation](#-documentation)

---

## 🎯 Core Features

- ✅ Seamless PayPal payment integration
- 🔁 Vaulted auto-renewals: save the buyer's PayPal wallet at checkout and charge it off-session on every billing cycle
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

## ⚙️ Plugin Options

The following options can be passed to the PayPal plugin in your `medusa-config.js` or `medusa.config.ts` file:

| Option                | Type      | Default | Description                                                                                     |
| --------------------- | --------- | ------- | ----------------------------------------------------------------------------------------------- |
| `clientId`            | `string`  |         | Required. Your PayPal API client ID.                                                            |
| `clientSecret`        | `string`  |         | Required. Your PayPal API client secret.                                                        |
| `isSandbox`           | `boolean` | `true`  | Whether to use the PayPal Sandbox environment for testing.                                      |
| `webhookId`           | `string`  |         | Optional. Your PayPal webhook ID. If provided, enables confirmation of payment captures.        |
| `includeShippingData` | `boolean` | `false` | Optional. If `true`, shipping data from the storefront order will be added to the PayPal order. |
| `includeCustomerData` | `boolean` | `false` | Optional. If `true`, customer data from the storefront order will be added to the PayPal order. |

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
