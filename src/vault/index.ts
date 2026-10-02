/**
 * No-charge payment-method binding (PayPal Vault v3).
 *
 * The chain is: create a setup token, send the payer to the approval URL,
 * then exchange the approved setup token for a permanent payment token - the
 * vault id the subscription engine later charges off-session. No money moves
 * at any step, which is exactly what a free trial needs before its first
 * charge.
 *
 * Sandbox reads the setup token back as `VAULTED`, not `APPROVED`, once the
 * payer has approved, so the exchange runs for any status in
 * `EXCHANGEABLE_SETUP_TOKEN_STATUSES` instead of keying on `APPROVED` alone.
 *
 * This is deliberately separate from the provider's `store_in_vault:
 * ON_SUCCESS` path: that one binds the wallet during an order capture, so it
 * can never produce a vault id for a free trial - a trial has nothing to
 * capture. The two paths coexist; this module does not replace the first.
 */

import type { PaypalService } from "../providers/paypal/paypal-core/paypal-core";

/**
 * Capability name exposed to consumers that detect this feature by
 * duck-typing the resolved service (`typeof svc.startVaultApproval ===
 * "function"`). The reorder engine has no dependency on this package and
 * cannot import the constant, so the duck-type is the mechanism and this
 * constant is the documentation of what that method means.
 */
export const PAYPAL_VAULT_BINDING_CAPABILITY = "vault-binding";

export type StartVaultApprovalInput = {
  customer_id: string;
  return_url: string;
  cancel_url: string;
};

export type StartVaultApprovalResult = {
  setup_token_id: string;
  approve_url: string;
};

export type CompleteVaultApprovalInput = {
  setup_token_id: string;
};

export type CompleteVaultApprovalResult = {
  status: string;
  vault_id?: string;
};

/** Setup-token statuses that mean the payer approved and the token can be exchanged. */
export const EXCHANGEABLE_SETUP_TOKEN_STATUSES = ["APPROVED", "VAULTED", "TOKENIZED"] as const;

function isExchangeableSetupTokenStatus(status: string): boolean {
  return (EXCHANGEABLE_SETUP_TOKEN_STATUSES as readonly string[]).includes(status);
}

export async function startVaultApproval(
  client: PaypalService,
  input: StartVaultApprovalInput,
): Promise<StartVaultApprovalResult> {
  const created = await client.createVaultSetupToken(input);

  return { setup_token_id: created.setup_token_id, approve_url: created.approve_url };
}

export async function completeVaultApproval(
  client: PaypalService,
  input: CompleteVaultApprovalInput,
): Promise<CompleteVaultApprovalResult> {
  const state = await client.getVaultSetupToken(input.setup_token_id);

  if (!isExchangeableSetupTokenStatus(state.status)) {
    return { status: state.status };
  }

  const token = await client.createVaultPaymentToken(input.setup_token_id);

  return { status: state.status, vault_id: token.vault_id };
}
