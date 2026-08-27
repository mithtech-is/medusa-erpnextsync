import { Migration } from "@mikro-orm/migrations"

/**
 * Configurable Frappe receive method.
 *
 * Additive nullable column on the `erpnext_setting` singleton. NULL
 * means "use ERPNEXT_RECEIVE_METHOD env, else the built-in default
 * (`medusync.api.receive`)", so existing rows keep pushing to the same
 * endpoint they did before. Set it per deployment to point the plugin
 * at whatever whitelisted method the target Frappe app exposes.
 */
export class Migration20260824000000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "frappe_receive_method" TEXT NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "frappe_receive_method";
        `)
    }
}
