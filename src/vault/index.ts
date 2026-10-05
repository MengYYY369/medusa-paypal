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

export { ApprovalAlreadyUsedError } from "../providers/paypal/paypal-core/paypal-core";

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

/**
 * Completes a vault approval by exchanging the approved setup token for the
 * permanent payment token.
 *
 * The contract for callers (the binder, and through it the
 * `medusa-payment-methods` plugin):
 *
 * - The reference is `vault_id`, taken verbatim from the create-payment-token
 *   response. It is authoritative the moment the exchange returns. Callers
 *   must never resolve or verify it by listing vault payment methods
 *   afterwards: PayPal v3's create-then-list read-after-write latency drops
 *   freshly minted tokens from the list, which used to surface as a 409
 *   `bindingNotVerified` on a bind that had actually succeeded (defect D1).
 * - A duplicated `complete` of the same approval session does not mint a
 *   second vault id: the exchange carries a deterministic PayPal-Request-Id,
 *   so the duplicate replays the original response within PayPal's request-id
 *   window.
 * - If PayPal rejects the exchange because the approval session was already
 *   used, the failure is `ApprovalAlreadyUsedError` - callers map it to an
 *   idempotent success with the method the first complete created.
 * - A setup token the payer has not approved (or whose approval expired)
 *   resolves with `status` only and no `vault_id`; the caller refuses.
 */
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
