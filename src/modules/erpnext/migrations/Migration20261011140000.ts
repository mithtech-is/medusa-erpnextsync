import { Migration } from "@mikro-orm/migrations"

/** Whether gateway settlements are booked, into which bank account, and from which supplier. */
export class Migration20261011140000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "book_settlements" boolean NOT NULL DEFAULT false;`)
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "settlement_bank_account" text NULL;`)
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "create_settlement_bank_account" boolean NOT NULL DEFAULT false;`)
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "gateway_suppliers" jsonb NULL;`)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "gateway_suppliers";`)
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "create_settlement_bank_account";`)
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "settlement_bank_account";`)
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "book_settlements";`)
    }
}
