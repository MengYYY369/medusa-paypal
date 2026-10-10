import { MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
} from "@medusajs/framework/utils";
import { resolveSubscriptionModule } from "../../../../../lib/paypal";

type ReviseBody = { variant_id?: string };

/**
 * Customer self-service plan switch.
 *
 * Revises the PayPal subscription in place: the subscription id, its approval
 * and its billing history survive, the new plan applies from the next billing
 * cycle, and the remainder of the current cycle is not prorated. The
 * subscription must belong to the authenticated customer - other people's
 * subscriptions return 404 (no existence leak), exactly like cancel - and the
 * target plan must belong to the same product.
 *
 * A switch to the plan the subscription is already on is a no-op that returns
 * the unchanged row, so a retried request cannot fail on its own success.
 *
 * PayPal treats a plan change as a consent request, so the usual response is
 * `pending: true` with an `approval_url`: nothing local has moved yet, the
 * storefront sends the buyer to PayPal, and the switch lands through the
 * BILLING.SUBSCRIPTION.UPDATED webhook (or the nightly reconciliation pass).
 * `pending: false` means the switch needed no consent and `subscription`
 * already carries the new plan.
 */
export const POST = async (
  req: MedusaStoreRequest<ReviseBody>,
  res: MedusaResponse
) => {
  const customerId = (req.auth_context?.actor_id as string) ?? "";

  if (!customerId) {
    return res.status(401).json({ error: "Customer authentication required" });
  }

  const variantId = req.validatedBody?.variant_id ?? req.body?.variant_id;

  if (!variantId) {
    return res.status(400).json({ error: "variant_id is required" });
  }

  const module = resolveSubscriptionModule(req.scope);

  try {
    const { subscription, approvalUrl, pending } = await module.customerRevise(
      req.params.id,
      customerId,
      { variantId },
      {
        productModule: req.scope.resolve(Modules.PRODUCT),
        query: req.scope.resolve(ContainerRegistrationKeys.QUERY),
      }
    );

    return res.status(200).json({
      subscription,
      approval_url: approvalUrl,
      pending,
    });
  } catch (error) {
    if (
      error instanceof MedusaError &&
      error.type === MedusaError.Types.NOT_FOUND
    ) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    // Refusals the customer can act on (not a subscription variant, not
    // ACTIVE, another product's plan, PayPal's own 422): a 400 with the
    // engine's message, which names the way out.
    if (
      error instanceof MedusaError &&
      error.type === MedusaError.Types.INVALID_DATA
    ) {
      return res
        .status(400)
        .json({ error: error.message, code: error.code ?? null });
    }

    throw error;
  }
};
