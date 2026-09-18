import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentWebhookEvents,
} from "@medusajs/framework/utils";
import { PaypalService } from "../../../../providers/paypal/paypal-core";
import { isSubscriptionEvent } from "../../../../subscription/engine";
import { findPaypalProviderDeclaration } from "../../../lib/paypal";

/**
 * Plugin-owned webhook endpoint for the subscription rail (dual-webhook
 * topology): PayPal webhook #2 targets this route and carries only
 * subscription-class events (BILLING.SUBSCRIPTION.*, PAYMENT.SALE.*).
 *
 * Non-subscription events (e.g. PAYMENT.CAPTURE.*) are acknowledged but NOT
 * forwarded - they belong to the standard Medusa payment webhook, and
 * forwarding them here would deliver them twice. Verified subscription
 * events are re-emitted on the event bus as the standard
 * PaymentWebhookEvents.WebhookReceived, reusing Medusa's delayed, retried
 * processing (and thereby the provider's getWebhookActionAndData mapping,
 * including the standard captured mechanism for first-period charges).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
  try {
    const paymentModule = req.scope.resolve("payment") as any;

    const provider = findPaypalProviderDeclaration(paymentModule);

    if (!provider) {
      return res.status(404).json({ error: "PayPal provider not found" });
    }

    const client = new PaypalService(provider.options);

    try {
      await client.verifyWebhook({
        headers: req.headers as Record<string, string>,
        body: req.body as object,
        webhookId:
          provider.options.subscriptionWebhookId ?? provider.options.webhookId,
      });
    } catch (error) {
      req.scope
        .resolve<any>(ContainerRegistrationKeys.LOGGER)
        .warn?.(
          `PayPal subscription webhook signature verification failed: ${String(error)}`
        );

      return res.status(401).json({ received: false, error: "invalid signature" });
    }

    const eventType = (req.body as any)?.event_type as string;

    if (!eventType || !isSubscriptionEvent(eventType)) {
      // Acknowledge but never forward payment-class events (double delivery).
      return res.status(200).json({ received: true, handled: false });
    }

    const eventBus = req.scope.resolve<any>(Modules.EVENT_BUS);
    const options = (paymentModule.options ?? {}) as Record<string, any>;

    await eventBus.emit(
      {
        name: PaymentWebhookEvents.WebhookReceived,
        data: {
          provider: provider.registrationKey,
          payload: {
            data: req.body,
            rawData: (req as any).rawBody,
            headers: req.headers,
          },
        },
      },
      {
        delay: options.webhook_delay || 5000,
        attempts: options.webhook_retries || 3,
      }
    );

    return res.status(200).json({ received: true, handled: true });
  } catch (error) {
    req.scope
      .resolve<any>(ContainerRegistrationKeys.LOGGER)
      .error?.(`PayPal subscription webhook error: ${String(error)}`);

    return res.status(400).json({ received: false, error: "webhook error" });
  }
};
