import { MedusaError } from "@medusajs/framework/utils";
import { PaypalService } from "../../providers/paypal/paypal-core";
import { PaypalPluginOptionsType } from "../../providers/paypal/service";
import {
  assertPaypalConfigured,
  mergePaypalConfigLayers,
  PaypalResolvedConfig,
} from "../../modules/paypal-subscription/lib/config-resolver";

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
  /**
   * Provider id as the payment module's webhook dispatch expects it:
   * the module prepends "pp_" itself, so this is the registration key
   * WITHOUT the "pp_" prefix (e.g. "paypal" / "paypal_shop").
   */
  webhookProviderId: string;
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
        webhookProviderId: `paypal${provider.id ? `_${provider.id}` : ""}`,
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

/**
 * Builds a PayPal client from the configuration resolved right now: through
 * the subscription module's resolver when the module is registered (DB
 * overrides -> provider options -> plugin options), and through the provider
 * options alone otherwise. Throws the shared configuration error when the
 * credentials are missing - an unconfigured SDK client would send
 * `Basic Og==` and surface as a confusing PayPal 401.
 */
export async function resolvePaypalClient(
  scope: { resolve: (key: string) => unknown },
  providerOptions: PaypalPluginOptionsType
): Promise<{ client: PaypalService; config: PaypalResolvedConfig }> {
  let config: PaypalResolvedConfig;

  try {
    const module = resolveSubscriptionModule(scope);
    const resolved = await module.getResolvedPaypalConfig({ providerOptions });

    config = resolved.config;
  } catch {
    // Module not registered (or no resolver on it): the provider options are
    // the only configured layer.
    config = mergePaypalConfigLayers({ providerOptions }).config;
  }

  assertPaypalConfigured(config);

  return { client: new PaypalService(config), config };
}
