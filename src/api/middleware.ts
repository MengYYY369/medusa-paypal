import { defineMiddlewares } from "@medusajs/framework/http";

export default defineMiddlewares({
  routes: [
    {
      matcher: "/store/paypal/client-token",
      methods: ["POST"],
    },
    {
      matcher: "/store/paypal/account-holder",
      methods: ["POST"],
    },
  ],
});
