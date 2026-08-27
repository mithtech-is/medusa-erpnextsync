import { Migration } from "@mikro-orm/migrations"

/**
 * F0 — schema prep for real-time-with-fallbacks (F1→F5).
 *
 * Two changes, both additive (no rename, no drop) so this migration
 * is safe to run on existing deployments mid-flight.
 *
 *   1. `erpnext_sync_event.direction` — new TEXT column (default
 *      'outbound') that lets one row distinguish a Medusa→Frappe
 *      push (existing, the only kind today) from a Frappe→Medusa
 *      inbound POST (added in F1). Indexed because the retry +
 *      reconciliation crons scan by (status, direction).
 *
 *   2. `erpnext_setting.frappe_to_medusa_secret` — new TEXT column
 *      (nullable). Holds the secret that Frappe-side `Webhook` rows
 *      (seeded by F2) sign with, and that the F1 inbound receiver
 *      verifies. Kept SEPARATE from the existing `webhook_secret`
 *      column (which we treat as `medusa_to_frappe_secret`) so each
 *      direction can be rotated independently — a leak on one side
 *      doesn't compromise the other.
 *
 * Rollback is symmetric: drop the column + index. Existing data is
 * preserved.
 */
export class Migration20260527150000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_sync_event"
                ADD COLUMN IF NOT EXISTS "direction" TEXT NOT NULL DEFAULT 'outbound';
        `)
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_sync_event_direction" ON "erpnext_sync_event" ("direction") WHERE deleted_at IS NULL;`,
        )
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "frappe_to_medusa_secret" TEXT NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(
            `ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "frappe_to_medusa_secret";`,
        )
        this.addSql(
            `DROP INDEX IF EXISTS "IDX_erpnext_sync_event_direction";`,
        )
        this.addSql(
            `ALTER TABLE "erpnext_sync_event" DROP COLUMN IF EXISTS "direction";`,
        )
    }
}
