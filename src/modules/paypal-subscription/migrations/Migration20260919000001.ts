import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * First tables shipped by the plugin. Created plain (no FKs) - rows reference
 * Medusa aggregates (variants, customers, sessions) by id only, mirroring how
 * the payment module stores provider-side references.
 */
export class Migration20260919000001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "paypal_plan" (
        "id" TEXT NOT NULL,
        "variant_id" TEXT NOT NULL,
        "currency_code" TEXT NOT NULL,
        "paypal_product_id" TEXT NOT NULL,
        "paypal_plan_id" TEXT NOT NULL,
        "config_hash" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'ACTIVE',
        "metadata" JSONB NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMPTZ NULL,
        CONSTRAINT "paypal_plan_pkey" PRIMARY KEY ("id")
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "paypal_plan_paypal_plan_id_key" ON "paypal_plan" ("paypal_plan_id");
      CREATE INDEX IF NOT EXISTS "IDX_paypal_plan_variant" ON "paypal_plan" ("variant_id");
      CREATE INDEX IF NOT EXISTS "IDX_paypal_plan_hash" ON "paypal_plan" ("config_hash");

      CREATE TABLE IF NOT EXISTS "paypal_subscription" (
        "id" TEXT NOT NULL,
        "paypal_subscription_id" TEXT NOT NULL,
        "paypal_plan_id" TEXT NULL,
        "variant_id" TEXT NOT NULL,
        "customer_id" TEXT NULL,
        "payment_session_id" TEXT NOT NULL,
        "payment_collection_id" TEXT NULL,
        "provider_id" TEXT NULL,
        "status" TEXT NOT NULL DEFAULT 'APPROVAL_PENDING',
        "locked_amount" INTEGER NOT NULL,
        "currency_code" TEXT NOT NULL,
        "interval_unit" TEXT NOT NULL,
        "interval_count" INTEGER NOT NULL,
        "first_sale_id" TEXT NULL,
        "next_billing_at" TIMESTAMPTZ NULL,
        "last_billing_at" TIMESTAMPTZ NULL,
        "failure_count" INTEGER NOT NULL DEFAULT 0,
        "sales" JSONB NOT NULL DEFAULT '[]'::jsonb,
        "refunds" JSONB NOT NULL DEFAULT '[]'::jsonb,
        "metadata" JSONB NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMPTZ NULL,
        CONSTRAINT "paypal_subscription_pkey" PRIMARY KEY ("id")
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "paypal_subscription_paypal_subscription_id_key" ON "paypal_subscription" ("paypal_subscription_id");
      CREATE INDEX IF NOT EXISTS "IDX_paypal_subscription_variant" ON "paypal_subscription" ("variant_id");
      CREATE INDEX IF NOT EXISTS "IDX_paypal_subscription_customer" ON "paypal_subscription" ("customer_id");
      CREATE INDEX IF NOT EXISTS "IDX_paypal_subscription_session" ON "paypal_subscription" ("payment_session_id");
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS "paypal_subscription";
      DROP TABLE IF EXISTS "paypal_plan";
    `);
  }
}
