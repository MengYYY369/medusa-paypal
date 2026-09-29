import { MedusaRequest, MedusaResponse } from "@medusajs/framework";
import { resolveSubscriptionModule } from "../../../../lib/paypal";
import type { AdminListPaypalSettingsAuditQueryType } from "../../../../middlewares";
import { resolveActorNames } from "../utils";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function toIsoString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Change history for the settings page: newest first, default 20 rows, capped
 * at 100. `changed_fields` is the field-level diff written by
 * `savePaypalSettings` (secrets already masked there).
 */
export const GET = async (
  req: MedusaRequest<unknown, AdminListPaypalSettingsAuditQueryType>,
  res: MedusaResponse
) => {
  const module = resolveSubscriptionModule(req.scope);

  const requested = Number(
    (req.validatedQuery as AdminListPaypalSettingsAuditQueryType | undefined)
      ?.limit ?? req.query?.limit
  );
  const limit =
    Number.isFinite(requested) && requested > 0
      ? Math.min(Math.floor(requested), MAX_LIMIT)
      : DEFAULT_LIMIT;

  const audits = await module.listPaypalSettingsAudits(
    {},
    { take: limit, order: { created_at: "DESC" } }
  );

  const actorIdSet = new Set<string>();

  for (const row of audits ?? []) {
    const actorId = (row as any)?.actor_id;

    if (typeof actorId === "string" && actorId !== "") {
      actorIdSet.add(actorId);
    }
  }

  const actorNames = await resolveActorNames(req.scope, [...actorIdSet]);

  return res.status(200).json({
    audits: (audits ?? []).map((row: any) => ({
      id: row.id,
      actorId: row.actor_id ?? null,
      actorName: row.actor_id
        ? actorNames.get(row.actor_id) ?? row.actor_id
        : null,
      changedFields: row.changed_fields ?? {},
      createdAt: toIsoString(row.created_at),
    })),
  });
};
