import { Migration } from "@mikro-orm/migrations"

/** Which ERPNext Mode of Payment each Medusa payment provider books to. */
export class Migration20261011093100 extends Migration {
    async up(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "payment_modes" jsonb NULL;`)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "payment_modes";`)
    }
}
