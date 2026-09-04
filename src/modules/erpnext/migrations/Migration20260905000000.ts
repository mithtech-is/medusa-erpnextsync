import { Migration } from "@mikro-orm/migrations"

/**
 * Tell a rehearsal apart from real traffic.
 *
 * The mapping studio can send a genuine signed request marked `dry_run`:
 * the far side checks the signature, the replay window and its own rules,
 * then stops before the write. That is the only check that proves the
 * shared secret, the network and the far side's verdict at once.
 *
 * The row it leaves looks exactly like a delivery, which is the problem.
 * Without this column the retry job would re-send a fabricated payload
 * for real, and the `skip_unchanged` guard would let a rehearsed success
 * suppress a genuine push as a duplicate. Both failures are invisible
 * from either end.
 *
 * Defaults to false, so every existing row is real traffic — which it is.
 */
export class Migration20260905000000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_sync_event"
                ADD COLUMN IF NOT EXISTS "is_test" BOOLEAN NOT NULL DEFAULT FALSE;
        `)
        // The retry queue and the prune both filter on it, and the table
        // is overwhelmingly real rows, so a partial index is the cheap one.
        this.addSql(`
            CREATE INDEX IF NOT EXISTS "IDX_erpnext_sync_event_is_test"
                ON "erpnext_sync_event" ("is_test") WHERE "is_test" = TRUE;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`DROP INDEX IF EXISTS "IDX_erpnext_sync_event_is_test";`)
        this.addSql(`ALTER TABLE "erpnext_sync_event" DROP COLUMN IF EXISTS "is_test";`)
    }
}
