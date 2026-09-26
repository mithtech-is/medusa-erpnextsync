import { Migration } from "@mikro-orm/migrations"

/**
 * Phase 3: stock and prices, ERPNext → Medusa. Both off until switched
 * on in Settings; the warehouse and stock location name where levels
 * come from and go to.
 */
export class Migration20260927013045 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "sync_stock" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "sync_prices" boolean NOT NULL DEFAULT false,
                ADD COLUMN IF NOT EXISTS "erpnext_warehouse" text NULL,
                ADD COLUMN IF NOT EXISTS "medusa_stock_location_id" text NULL,
                ADD COLUMN IF NOT EXISTS "erpnext_safety_stock" integer NOT NULL DEFAULT 0;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "sync_stock",
                DROP COLUMN IF EXISTS "sync_prices",
                DROP COLUMN IF EXISTS "erpnext_warehouse",
                DROP COLUMN IF EXISTS "medusa_stock_location_id",
                DROP COLUMN IF EXISTS "erpnext_safety_stock";
        `)
    }
}
