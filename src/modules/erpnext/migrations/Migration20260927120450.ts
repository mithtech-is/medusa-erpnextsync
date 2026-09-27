import { Migration } from "@mikro-orm/migrations"

/** A sync may span several DocTypes: the secondary ones and their links. */
export class Migration20260927120450 extends Migration {
    async up(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_mapping" ADD COLUMN IF NOT EXISTS "secondary_doctypes" jsonb NULL;`)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_mapping" DROP COLUMN IF EXISTS "secondary_doctypes";`)
    }
}
