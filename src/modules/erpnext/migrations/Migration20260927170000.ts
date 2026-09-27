import { Migration } from "@mikro-orm/migrations"

/** Wallet and line-of-credit sync switches, and the bank account a
 *  UTR-bearing store deposit is booked into as a Wallet Deposit. */
export class Migration20260927170000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "sync_wallet" boolean NOT NULL DEFAULT false;`)
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "sync_credit" boolean NOT NULL DEFAULT false;`)
        this.addSql(`ALTER TABLE "erpnext_setting" ADD COLUMN IF NOT EXISTS "erpnext_wallet_bank_account" text NULL;`)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "sync_wallet";`)
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "sync_credit";`)
        this.addSql(`ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "erpnext_wallet_bank_account";`)
    }
}
