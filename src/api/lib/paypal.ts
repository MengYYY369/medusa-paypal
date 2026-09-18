import { MedusaError } from "@medusajs/framework/utils";
import { PaypalPluginOptionsType } from "../../providers/paypal/service";

interface PaymentProvidersProps {
  resolve: string;
  id: string;
  options: PaypalPluginOptionsType;
}

interface PaymentModuleLike {
  moduleDeclaration?: { providers?: PaymentProvidersProps[] };
}

export interface PaypalProviderDeclaration {
  id?: string;
  options: PaypalPluginOptionsType;
  /** Container registration key, e.g. "pp_paypal" or "pp_paypal_paypal". */
  registrationKey: string;
}

/**
 * Locates the PayPal provider declaration on the payment module - the same
 * mechanism the client-token route uses to read provider options.
 */
export function findPaypalProviderDeclaration(
  paymentModule: PaymentModuleLike | undefined
): PaypalProviderDeclaration | undefined {
  const providers = paymentModule?.moduleDeclaration?.providers ?? [];

  for (const provider of providers) {
    const resolve = String(provider.resolve ?? "");
    const isPaypal =
      provider.id === "paypal" ||
      resolve.toLowerCase().includes("paypal");

    if (isPaypal) {
      return {
        id: provider.id,
        options: provider.options,
        registrationKey: `pp_paypal${provider.id ? `_${provider.id}` : ""}`,
      };
    }
  }

  return undefined;
}

/**
 * Resolves the plugin's paypal_subscription module - the always-registered
 * orchestration surface for subscription operations.
 */
export function resolveSubscriptionModule(scope: {
  resolve: (key: string) => unknown;
}): any {
  const module = scope.resolve("paypalSubscription");

  if (!module) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "paypal_subscription module is not registered - is the PayPal plugin installed?"
    );
  }

  return module;
}
