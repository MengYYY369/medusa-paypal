import { MedusaRequest, MedusaResponse, MedusaStoreRequest } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { resolveSubscriptionModule } from "../../../lib/paypal";

type CreateBody = { session_id?: string };

/**
 * Storefront entry points for subscriptions.
 *
 * GET: the authenticated customer's subscriptions (ownership scoped to the
 * auth actor).
 *
 * POST (Buttons support): idempotent get-or-create of the PayPal subscription
 * for a payment session - returns the subscription id that the PayPal JS SDK
 * `createSubscription` callback needs. Sessions already carrying a
 * subscription (created during initiatePayment) return their existing id, so
 * the Buttons path and the redirect path can never double-create.
 */
export const GET = async (req: MedusaStoreRequest, res: MedusaResponse) => {
  const customerId = (req.auth_context?.actor_id as string) ?? "";

  if (!customerId) {
    return res.status(401).json({ error: "Customer authentication required" });
  }

  const module = resolveSubscriptionModule(req.scope);
  const subscriptions = await module.listForCustomer(customerId);

  return res.status(200).json({ subscriptions });
};

export const POST = async (req: MedusaRequest<CreateBody>, res: MedusaResponse) => {
  const sessionId = req.body?.session_id;

  if (!sessionId) {
    return res.status(400).json({ error: "session_id is required" });
  }

  const module = resolveSubscriptionModule(req.scope);
  const paymentModule = req.scope.resolve<any>("payment");

  const session = await paymentModule.retrievePaymentSession(sessionId);

  if (!session) {
    return res.status(404).json({ error: "Payment session not found" });
  }

  const sessionData = (session.data ?? {}) as Record<string, unknown>;

  // Already created during initiatePayment (redirect flow) or a previous
  // call - return the existing id.
  if (sessionData.paypal_subscription_id) {
    return res.status(200).json({
      subscription: {
        id: sessionData.paypal_subscription_id,
        subscription_id: sessionData.paypal_subscription_id,
        status: sessionData.is_subscription ? "APPROVAL_PENDING" : null,
      },
      existing: true,
    });
  }

  // Not yet created: resolve the cart behind the session and validate it is
  // a single-subscription checkout before creating the PayPal subscription.
  const query = req.scope.resolve<any>(ContainerRegistrationKeys.QUERY);

  const cartLinks = await query.graph({
    entity: "cart_payment_collection",
    filters: { payment_collection_id: session.payment_collection_id },
    fields: ["cart_id"],
  });

  const cartId = cartLinks?.data?.[0]?.cart_id;

  if (!cartId) {
    return res
      .status(400)
      .json({ error: "Payment session is not linked to a cart" });
  }

  const cartModule = req.scope.resolve<any>(Modules.CART);
  const cart = await cartModule.retrieveCart(cartId, { relations: ["items"] });

  const detection = await module.detectSubscriptionSession(
    { items: cart.items },
    { productModule: req.scope.resolve(Modules.PRODUCT) }
  );

  if (!detection.subscription || !detection.variant) {
    return res.status(400).json({
      error: "Payment session is not a subscription checkout",
    });
  }

  const sessionReturnUrl =
    typeof sessionData.return_url === "string" ? sessionData.return_url : undefined;
  const sessionCancelUrl =
    typeof sessionData.cancel_url === "string" ? sessionData.cancel_url : undefined;

  const subscription = await module.getOrCreateSubscriptionForSession(
    {
      sessionId,
      variantId: detection.variant.id,
      currencyCode: session.currency_code ?? cart.currency_code,
      amount: Number(session.amount),
      email: cart.email ?? undefined,
      customerId: cart.customer_id ?? undefined,
      returnUrl: sessionReturnUrl,
      cancelUrl: sessionCancelUrl,
    },
    { productModule: req.scope.resolve(Modules.PRODUCT) }
  );

  return res.status(201).json({ subscription });
};
