import { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { resolveSubscriptionModule } from "../../../../../lib/paypal";

/**
 * Customer self-service cancellation. The subscription must belong to the
 * authenticated customer; other people's subscriptions return 404 (no
 * existence leak). Cancelling stops future charges immediately; paid periods
 * keep their entitlements until period end (PayPal semantics).
 */
export const POST = async (
  req: MedusaStoreRequest,
  res: MedusaResponse
) => {
  const customerId = (req.auth_context?.actor_id as string) ?? "";

  if (!customerId) {
    return res.status(401).json({ error: "Customer authentication required" });
  }

  const module = resolveSubscriptionModule(req.scope);

  try {
    const subscription = await module.customerCancel(req.params.id, customerId);

    return res.status(200).json({ subscription });
  } catch (error) {
    if (
      error instanceof MedusaError &&
      error.type === MedusaError.Types.NOT_FOUND
    ) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    throw error;
  }
};
