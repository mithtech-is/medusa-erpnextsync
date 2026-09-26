import { Migration } from "@mikro-orm/migrations"

/**
 * Phase 2: Medusa → ERPNext over REST. The settings that name where a
 * pushed document lands — the Company, the selling price list, the
 * customer group and territory a new Customer gets, the account that
 * books shipping and the taxes template — all nullable, all falling back
 * to ERPNext's own defaults when empty.
 */
export class Migration20260926203015 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "erpnext_company" text NULL,
                ADD COLUMN IF NOT EXISTS "erpnext_price_list" text NULL,
                ADD COLUMN IF NOT EXISTS "erpnext_customer_group" text NULL,
                ADD COLUMN IF NOT EXISTS "erpnext_territory" text NULL,
                ADD COLUMN IF NOT EXISTS "erpnext_shipping_account" text NULL,
                ADD COLUMN IF NOT EXISTS "erpnext_taxes_template" text NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "erpnext_company",
                DROP COLUMN IF EXISTS "erpnext_price_list",
                DROP COLUMN IF EXISTS "erpnext_customer_group",
                DROP COLUMN IF EXISTS "erpnext_territory",
                DROP COLUMN IF EXISTS "erpnext_shipping_account",
                DROP COLUMN IF EXISTS "erpnext_taxes_template";
        `)
    }
}
