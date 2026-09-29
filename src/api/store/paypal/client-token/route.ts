import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { PostStorePaypalPaymentType } from "./validators";
import {
  findPaypalProviderDeclaration,
  resolvePaypalClient,
} from "../../../lib/paypal";

export const POST = async (
  req: MedusaRequest<PostStorePaypalPaymentType>,
  res: MedusaResponse
) => {
  const paymentModule = req.scope.resolve<any>("payment");

  // Shared lookup (also accepts a declaration without an `id`, where the
  // registration key is "pp_paypal"): a host that registers the provider as
  // `{ resolve: ".../providers/paypal", options }` must not 404 here.
  const paypalProvider = findPaypalProviderDeclaration(paymentModule);

  if (!paypalProvider) {
    return res.status(404).json({ error: "Paypal provider not found" });
  }

  // The client carries the resolved environment, including its REST base URL.
  const { client } = await resolvePaypalClient(req.scope, paypalProvider.options);

  const accessToken = await client.getAccessToken();

  const response = await fetch(`${client.baseUrl}/v1/identity/generate-token`, {
    method: "post",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Accept-Language": "en_US",
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();

  return res.status(201).json({ client_token: data.client_token });
};
