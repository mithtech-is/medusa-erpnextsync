import { Migration } from "@mikro-orm/migrations"

/** The pull watermark keeps Frappe's `modified` exactly, microseconds included. */
export class Migration20261011093000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_mapping" ADD COLUMN IF NOT EXISTS "last_pull_modified" text NULL;`)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_mapping" DROP COLUMN IF EXISTS "last_pull_modified";`)
    }
}
