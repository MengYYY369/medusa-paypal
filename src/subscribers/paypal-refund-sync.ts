import { PaymentWebhookEvents } from "@medusajs/framework/utils";
import { findPaypalProviderDeclaration, resolveSubscriptionModule } from "../api/lib/paypal";

type WebhookEventData = {
  provider?: string;
  payload?: { data?: { event_type?: string; resource?: any } };
};

/**
 * The subscriptions platform fires PAYMENT.CAPTURE.REFUNDED / REVERSED (on
 * the standard payment rail) for panel refunds of subscription charges -
 * verified live in sandbox; PAYMENT.SALE.REFUNDED is not emitted for them.
 * Medusa's payment webhook subscriber only maps session lifecycle actions,
 * so refund sync runs here: the refund's `custom` field carries the
 * subscription's custom_id (= our payment session id), which resolves the
 * subscription row and its first order.
 */
export default async function paypalRefundSync({
  event,
  container,
}: {
  event: { data: WebhookEventData };
  container: any;
}) {
  const body = event.data?.payload?.data;
  const resource = body?.resource;

  if (
    !resource ||
    !["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"].includes(
      body?.event_type ?? ""
    )
  ) {
    return;
  }

  const paymentModule = container.resolve("payment");
  const provider = findPaypalProviderDeclaration(paymentModule);

  if (!provider || event.data.provider !== provider.webhookProviderId) {
    return;
  }

  const subscriptionModule = resolveSubscriptionModule(container);

  await subscriptionModule.syncCaptureRefundFromPaypal(resource, {
    paymentModule: container.resolve("payment"),
    orderModule: container.resolve("order"),
  });
}

export const config = { event: PaymentWebhookEvents.WebhookReceived };
