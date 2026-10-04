/**
 * Host-facing payment-method binder.
 *
 * The `medusa-payment-methods` plugin defines the `PaymentMethodBinder`
 * contract and the host supplies the implementation through the plugin's
 * `binders` map (keyed by the payment module registration key). This module is
 * the PayPal implementation: it wraps the no-charge vault-approval flow
 * (`src/vault`) behind `start` / `complete`.
 *
 * Credentials are supplied explicitly by the host - the same values it already
 * passes to the PayPal payment provider - so this module reads no environment
 * variables of its own and holds no reference to the Medusa container (the
 * provider instance is not in the container, D12).
 *
 *     import { createPaypalBinder } from "@mengyyy369/medusa-paypal/binder"
 *
 *     binders: {
 *       pp_paypal_paypal: createPaypalBinder({
 *         clientId: process.env.PAYPAL_CLIENT_ID,
 *         clientSecret: process.env.PAYPAL_CLIENT_SECRET,
 *         isSandbox: process.env.PAYPAL_IS_SANDBOX === "true",
 *       }),
 *     }
 */

import { MedusaError } from "@medusajs/framework/utils";
import { PaypalService } from "../providers/paypal/paypal-core/paypal-core";
import { completeVaultApproval, startVaultApproval } from "../vault";

/** PayPal credentials the binder needs; the same source as the provider options. */
export type PaypalBinderOptions = {
  clientId: string;
  clientSecret: string;
  isSandbox: boolean;
};

export type PaymentMethodBinderStartInput = {
  customerId: string;
  providerId: string;
  returnUrl: string;
  cancelUrl: string;
};

export type PaymentMethodBinderStartResult = {
  /** URL the payer is redirected to for approval. */
  approvalUrl: string;
  /** Opaque handle the host passes back to `complete` (the setup token id). */
  state: string;
};

export type PaymentMethodBinderCompleteInput = {
  customerId: string;
  providerId: string;
  state: string;
};

export type PaymentMethodBinderCompleteResult = {
  /** The vaulted payment-token id the plugin stores as the method reference. */
  paymentMethodId: string;
  data: Record<string, unknown>;
};

export type PaymentMethodBinder = {
  /** Bind family for the storefront's bind rows (2026-10-04, item 5/10). */
  kind?: string
  start(
    input: PaymentMethodBinderStartInput,
  ): Promise<PaymentMethodBinderStartResult>;
  complete(
    input: PaymentMethodBinderCompleteInput,
  ): Promise<PaymentMethodBinderCompleteResult>;
};

/**
 * Builds a PayPal `PaymentMethodBinder` for the plugin's `binders` map. The
 * PayPal client is created lazily on first use and reused; the vault flow it
 * drives creates a setup token, returns the approval URL, then exchanges the
 * approved token for the permanent vault id.
 */
export function createPaypalBinder(
  options: PaypalBinderOptions,
): PaymentMethodBinder {
  let client: PaypalService | undefined;

  const getClient = (): PaypalService => {
    if (!client) {
      client = new PaypalService({
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        isSandbox: options.isSandbox,
        // The vault flow never captures an order, so these checkout-only
        // options are inert here.
        includeCustomerData: false,
        includeShippingData: false,
      });
    }

    return client;
  };

  return {
    kind: "paypal",
    async start({ customerId, returnUrl, cancelUrl }) {
      const started = await startVaultApproval(getClient(), {
        customer_id: customerId,
        return_url: returnUrl,
        cancel_url: cancelUrl,
      });

      return { approvalUrl: started.approve_url, state: started.setup_token_id };
    },

    async complete({ state }) {
      const result = await completeVaultApproval(getClient(), {
        setup_token_id: state,
      });

      if (!result.vault_id) {
        // The payer has not approved yet (or the approval expired): the setup
        // token has no vault id to hand back.
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `PayPal setup token is not approved (status: ${result.status})`,
        );
      }

      return {
        paymentMethodId: result.vault_id,
        data: { type: "paypal" },
      };
    },
  };
}
