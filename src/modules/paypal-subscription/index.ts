import { Module } from "@medusajs/framework/utils";
import PaypalSubscriptionModuleService from "./service";

/**
 * Plugin-owned module holding the subscription tables. Discovered
 * automatically from the plugin's src/modules and registered under this
 * service name - merchants only need to reference the key from their payment
 * module "dependencies" to inject it into the PayPal payment provider.
 */
export default Module("paypalSubscription", {
  service: PaypalSubscriptionModuleService,
});
