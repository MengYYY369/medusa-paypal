import { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { Modules } from "@medusajs/framework/utils";
import { PaypalPluginOptionsType } from "../../../../providers/paypal/service";

interface PaymentProvidersProps {
  resolve: string;
  id: string;
  options: PaypalPluginOptionsType;
}

interface PaymentModuleLike {
  moduleDeclaration?: { providers?: PaymentProvidersProps[] };
  createAccountHolder: (input: {
    provider_id: string;
    context: { customer: { id: string; email?: string } };
  }) => Promise<{ id?: string; data?: Record<string, unknown> }>;
}

interface CustomerModuleLike {
  retrieveCustomer: (id: string) => Promise<{ email?: string }>;
}

/**
 * Creates (or returns) the PayPal account holder for the authenticated
 * customer. The account holder is what ties vaulted PayPal wallets to a
 * Medusa customer so saved methods can be listed and swapped later.
 */
export const POST = async (
  req: MedusaStoreRequest,
  res: MedusaResponse
) => {
  const customerId = (req.auth_context?.actor_id as string) ?? "";

  if (!customerId) {
    return res.status(401).json({ error: "Customer authentication required" });
  }

  const paymentModule = req.scope.resolve<PaymentModuleLike>("payment");

  const paypalProvider = paymentModule.moduleDeclaration?.providers?.find(
    (provider) => provider.id === "paypal"
  );

  if (!paypalProvider) {
    return res.status(404).json({ error: "PayPal provider not found" });
  }

  const customerModule = req.scope.resolve<CustomerModuleLike>(
    Modules.CUSTOMER
  );
  const customer = await customerModule.retrieveCustomer(customerId);

  const accountHolder = await paymentModule.createAccountHolder({
    provider_id: paypalProvider.id,
    context: {
      customer: { id: customerId, email: customer.email },
    },
  });

  return res.status(201).json({ account_holder: accountHolder });
};
