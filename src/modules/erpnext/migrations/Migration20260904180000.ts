import { Migration } from "@mikro-orm/migrations"

/**
 * Sync selection, the Medusa half.
 *
 * ERPNext decides which documents may sync and which DocType holds the
 * catalogue; both travel to this side so the plugin looks in the right
 * place when someone asks to link a Medusa product to an existing one.
 *
 * `medusa_product_policy` is the one decision that belongs HERE, because
 * it governs what leaves Medusa: whether a product invented in the
 * storefront may create an ERPNext Item, may only attach to one that
 * exists, or must not travel at all. It defaults to link-only, so nothing
 * is invented in the catalogue by accident.
 */
export class Migration20260904180000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "products_doctype" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "medusa_product_policy" TEXT NOT NULL DEFAULT 'link';
        `)
    }

    async down(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "products_doctype",
                DROP COLUMN IF EXISTS "medusa_product_policy";
        `)
    }
}
