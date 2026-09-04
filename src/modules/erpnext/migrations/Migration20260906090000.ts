import { Migration } from "@mikro-orm/migrations"

/**
 * Two things the ERPNext side already had and this one did not.
 *
 * A circuit breaker on the connection: a Frappe site that has refused ten
 * pushes in a row will refuse the eleventh, and every attempt waits out
 * the timeout while the retry job keeps re-posting. The three columns on
 * `erpnext_setting` are the whole mechanism — count, stopped-at, and the
 * threshold — with the rules in `../breaker.ts` where they can be tested.
 *
 * And a way for a mapping to ask for a person. `attention` is set when
 * ERPNext enabled a mapping this side has not rehearsed, or when a mapping
 * names an ERPNext field the DocType no longer has. The second switches
 * that mapping off; the first leaves it alone and asks.
 *
 * And the enable gate: `tested_signature` is what a rehearsal approved,
 * compared with the mapping as it stands now, so a pass survives being
 * switched on and does not survive somebody adding a field afterwards.
 * `shipped_signature` is the same fingerprint taken when a default was
 * written, so an upgrade can tell an untouched default from an edited
 * one. See ../signature.ts.
 *
 * Every default is the "nothing is wrong" value, so existing rows are
 * unchanged by this landing.
 */
export class Migration20260906090000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS "tripped_at" TIMESTAMPTZ NULL,
                ADD COLUMN IF NOT EXISTS "trip_after" INTEGER NOT NULL DEFAULT 10;
        `)
        this.addSql(`
            ALTER TABLE "erpnext_mapping"
                ADD COLUMN IF NOT EXISTS "attention" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "attention_detail" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "tested_signature" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "shipped_signature" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "last_test_at" TIMESTAMPTZ NULL,
                ADD COLUMN IF NOT EXISTS "last_test_status" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "last_test_report" JSONB NULL;
        `)
        // "Which mappings need somebody?" is the question a dashboard asks
        // and the answer is almost always none, so index only the rows
        // that have one.
        this.addSql(`
            CREATE INDEX IF NOT EXISTS "IDX_erpnext_mapping_attention"
                ON "erpnext_mapping" ("attention")
                WHERE "attention" IS NOT NULL AND "deleted_at" IS NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`DROP INDEX IF EXISTS "IDX_erpnext_mapping_attention";`)
        this.addSql(`
            ALTER TABLE "erpnext_mapping"
                DROP COLUMN IF EXISTS "attention",
                DROP COLUMN IF EXISTS "attention_detail",
                DROP COLUMN IF EXISTS "tested_signature",
                DROP COLUMN IF EXISTS "shipped_signature",
                DROP COLUMN IF EXISTS "last_test_at",
                DROP COLUMN IF EXISTS "last_test_status",
                DROP COLUMN IF EXISTS "last_test_report";
        `)
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "consecutive_failures",
                DROP COLUMN IF EXISTS "tripped_at",
                DROP COLUMN IF EXISTS "trip_after";
        `)
    }
}
