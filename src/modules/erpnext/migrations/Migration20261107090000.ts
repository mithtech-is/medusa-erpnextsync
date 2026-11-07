import { Migration } from "@mikro-orm/migrations"

/** The Item Group ↔ category tree sync: its switch, direction and last report. */
export class Migration20261107090000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "sync_categories" boolean NOT NULL DEFAULT false;`)
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "category_direction" text NOT NULL DEFAULT 'pull';`)
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "category_sync_report" jsonb NULL;`)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "sync_categories";`)
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "category_direction";`)
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "category_sync_report";`)
    }
}
