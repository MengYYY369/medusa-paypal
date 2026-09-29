import { Migration } from "@medusajs/framework/mikro-orm/migrations";

/**
 * Admin-managed PayPal settings: one singleton row of field-level overrides
 * plus its audit trail. Every override column is nullable because NULL means
 * "inherit from medusa-config"; the two tables carry no FKs - actor_id
 * references a Medusa user or API key by id only.
 */
export class Migration20260929000001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "paypal_settings" (
        "id" TEXT NOT NULL,
        "client_id" TEXT NULL,
        "client_secret" TEXT NULL,
        "is_sandbox" BOOLEAN NULL,
        "webhook_id" TEXT NULL,
        "subscription_webhook_id" TEXT NULL,
        "include_shipping_data" BOOLEAN NULL,
        "include_customer_data" BOOLEAN NULL,
        "auto_bill_outstanding" BOOLEAN NULL,
        "payment_failure_threshold" INTEGER NULL,
        "version" INTEGER NOT NULL DEFAULT 1,
        "last_modified_by" TEXT NULL,
        "last_modified_at" TIMESTAMPTZ NULL,
        "last_verified_at" TIMESTAMPTZ NULL,
        "last_verified_ok" BOOLEAN NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMPTZ NULL,
        CONSTRAINT "paypal_settings_pkey" PRIMARY KEY ("id")
      );

      CREATE TABLE IF NOT EXISTS "paypal_settings_audit" (
        "id" TEXT NOT NULL,
        "actor_id" TEXT NULL,
        "changed_fields" JSONB NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMPTZ NULL,
        CONSTRAINT "paypal_settings_audit_pkey" PRIMARY KEY ("id")
      );
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS "paypal_settings_audit";
      DROP TABLE IF EXISTS "paypal_settings";
    `);
  }
}
