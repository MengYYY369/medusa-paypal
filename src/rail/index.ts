/**
 * Host-facing rail descriptor for PayPal.
 *
 * `medusa-payment-methods` consumes one descriptor per provider
 * (`options.providerDescriptors[<payment module registration key>]`). This module builds
 * PayPal's: the vault-approval binding protocol, the native subscription rail
 * (list / cancel / variant declaration), the provider's own error mapping, and
 * its labels.
 *
 *     import { createPaypalRail } from "@mengyyy369/medusa-paypal/rail"
 *
 *     providerDescriptors: {
 *       pp_paypal_paypal: createPaypalRail({
 *         providerId: "pp_paypal_paypal",
 *         clientId: process.env.PAYPAL_CLIENT_ID!,
 *         clientSecret: process.env.PAYPAL_CLIENT_SECRET!,
 *         isSandbox: process.env.PAYPAL_IS_SANDBOX === "true",
 *       }),
 *     }
 *
 * Credentials are supplied explicitly by the host — the same values it already
 * passes to the PayPal payment provider — so this module reads no environment
 * variables of its own and holds no reference to the Medusa container for the
 * binding path (the provider instance is not in the container, D12). The native
 * rail is the exception: it resolves the plugin's own module from the container
 * the caller passes in, exactly like the module's own routes do.
 */

import { MedusaError } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { PaypalService } from "../providers/paypal/paypal-core/paypal-core";
import {
  assertNoCredentialEnvironmentMismatch,
  detectDeclaredCredentialEnvironmentMismatch,
  PaypalCredentialEnvironmentMismatchError,
  PaypalEnvironment,
} from "../modules/paypal-subscription/lib/config-resolver";
import { ApprovalAlreadyUsedError, completeVaultApproval, startVaultApproval } from "../vault";
import {
  PAYPAL_RAIL_KIND,
  toNativeDeclaration,
  toNativeSubscriptionRecord,
} from "./records";
import type {
  NativeCancelOutcome,
  NativeSubscriptionRecord,
  PaymentProviderDescriptor,
} from "./types";

export * from "./types";
export { PAYPAL_RAIL_KIND } from "./records";

/** PayPal credentials the descriptors need; the same source as the provider options. */
export type PaypalRailOptions = {
  /**
   * The payment module's registration key this descriptor is mounted under
   * (`pp_paypal_paypal` for a provider declared as `paypal` with
   * `id: "paypal"`). The descriptor carries it; the host's map key stays what
   * the plugin resolves providers by.
   */
  providerId: string;
  clientId: string;
  clientSecret: string;
  isSandbox: boolean;
  /**
   * The environment this credential set belongs to, declared by hosts that
   * keep per-environment credential files. When it contradicts `isSandbox`
   * the factory throws at startup (#18) instead of binding a wallet in one
   * environment while the host charges in the other.
   */
  credentialEnvironment?: PaypalEnvironment;
  /** Overrides the admin/store label; defaults to `PayPal`. */
  displayName?: string;
};

/**
 * The payer has not approved the setup token yet (or the approval expired).
 *
 * A typed failure rather than a message the caller has to recognise: the
 * plugin classifies it through `isPendingApproval` and answers a retryable
 * 422, while a real provider outage stays a 502.
 */
export class PaypalApprovalPendingError extends MedusaError {
  readonly setupTokenStatus: string;

  constructor(status: string) {
    super(
      MedusaError.Types.INVALID_DATA,
      `PayPal setup token is not approved (status: ${status})`,
    );
    this.name = "PaypalApprovalPendingError";
    this.setupTokenStatus = status;
  }
}

/** The plugin's module registration key, for the rail's own reads. */
const PAYPAL_SUBSCRIPTION_MODULE = "paypalSubscription";

type SubscriptionModuleLike = {
  listSubscriptions?: (filters?: any, config?: any) => Promise<any[]>;
  listPaypalSubscriptions?: (filters?: any, config?: any) => Promise<any[]>;
  requestLifecycleAction?: (
    id: string,
    action: "cancel" | "suspend" | "resume",
  ) => Promise<any>;
};

/**
 * The plugin's module, resolved from the caller's container.
 *
 * `null` rather than a throw: every method below has a defensible answer for a
 * host that registered the payment provider without the subscription module.
 */
function resolveSubscriptionModule(
  container: MedusaContainer | null | undefined,
): SubscriptionModuleLike | null {
  try {
    const service = container?.resolve(PAYPAL_SUBSCRIPTION_MODULE) as
      | SubscriptionModuleLike
      | undefined;

    return service ?? null;
  } catch {
    return null;
  }
}

/**
 * Builds PayPal's `PaymentProviderDescriptor`.
 *
 * Startup guard (#18): when `credentialEnvironment` is declared and contradicts
 * `isSandbox`, the factory throws immediately — a misconfigured host fails at
 * boot instead of binding wallets through the wrong environment's API.
 */
export function createPaypalRail(
  options: PaypalRailOptions,
): PaymentProviderDescriptor {
  assertNoCredentialEnvironmentMismatch(
    detectDeclaredCredentialEnvironmentMismatch({
      declaredEnvironment: options.credentialEnvironment,
      declaredLayer: "self",
      sources: { clientId: "self", isSandbox: "self" },
      resolvedIsSandbox: options.isSandbox,
    }),
  );

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
    provider_id: options.providerId,
    kind: PAYPAL_RAIL_KIND,
    // A brand name: identical in every language this deployment speaks, so no
    // `display_name_i18n` — a consumer falls back to this one.
    display_name: options.displayName ?? "PayPal",

    binding: {
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
          // The payer has not approved yet (or the approval expired): the
          // setup token has no vault id to hand back.
          throw new PaypalApprovalPendingError(result.status);
        }

        return {
          paymentMethodId: result.vault_id,
          data: { type: "paypal" },
        };
      },

      /**
       * The exchange refused an approval that was already consumed. The caller
       * maps this to an idempotent replay of the method the first complete
       * created, so a repeated callback never fails and never mints twice.
       */
      isAlreadyCompleted(error) {
        return (
          error instanceof ApprovalAlreadyUsedError ||
          (error instanceof Error && error.name === "ApprovalAlreadyUsedError")
        );
      },

      isPendingApproval(error) {
        return (
          error instanceof PaypalApprovalPendingError ||
          (error instanceof Error && error.name === "PaypalApprovalPendingError")
        );
      },
    },

    native: {
      readVariantDeclaration(metadata) {
        return toNativeDeclaration(metadata);
      },

      async listRecords(container): Promise<NativeSubscriptionRecord[]> {
        const service = resolveSubscriptionModule(container);
        const list = service?.listSubscriptions ?? service?.listPaypalSubscriptions;

        if (!list) {
          // No module: there is nothing to read, and an empty list is the
          // honest answer (a consumer that mirrored previously will simply
          // keep what it has).
          return [];
        }

        const rows = (await list.call(service)) ?? [];

        return rows
          .map(toNativeSubscriptionRecord)
          .filter((record) => record.provider_subscription_id !== "");
      },

      /**
       * Cancels one subscription by this provider's own subscription id.
       *
       * The reference never contains a mirror key: the caller reads the raw id
       * from its own row. A subscription this provider does not know is
       * `skipped`, not an error — the caller may be holding a stale row, or a
       * row that was never a PayPal subscription at all.
       */
      async cancel(container, reference): Promise<NativeCancelOutcome> {
        const id = typeof reference === "string" ? reference.trim() : "";

        if (!id) {
          return { status: "skipped", reason: "provider_row_missing" };
        }

        const service = resolveSubscriptionModule(container);

        if (!service?.listSubscriptions || !service.requestLifecycleAction) {
          return { status: "skipped", reason: "capability_absent" };
        }

        const rows =
          (await service.listSubscriptions({
            paypal_subscription_id: id,
          })) ?? [];
        const row = rows[0];

        if (!row) {
          return { status: "skipped", reason: "provider_row_missing" };
        }

        try {
          await service.requestLifecycleAction(row.id, "cancel");

          return {
            status: "cancelled",
            provider_subscription_id: id,
            provider_row_id: row.id,
          };
        } catch (error) {
          return {
            status: "failed",
            provider_subscription_id: id,
            provider_row_id: row.id ?? null,
            error: error instanceof Error ? error.message : String(error ?? "unknown error"),
          };
        }
      },
    },

    /**
     * The credential-environment mismatch is an operator fault, not a customer
     * refusal: it keeps its 500 and its own message (the copy names both
     * environments, which is the only way the operator can see what to fix).
     * Everything else this provider throws is unclassified and becomes the
     * plugin's 502 `provider_error`.
     */
    mapError(error) {
      if (
        error instanceof PaypalCredentialEnvironmentMismatchError ||
        (error instanceof Error &&
          error.name === "PaypalCredentialEnvironmentMismatchError")
      ) {
        return { status: 500, type: "unexpected_state" };
      }

      return null;
    },
  };
}
