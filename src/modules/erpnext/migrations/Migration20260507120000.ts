import { Migration } from "@mikro-orm/migrations"

/**
 * `erpnext_sync_event` — durable per-event log for the ERPNext forwarder.
 *
 * One row per Medusa event id; updated on every retry attempt. The
 * admin route GET /admin/erpnext/events lists rows for visibility, and
 * POST /admin/erpnext/events/:id/retry re-runs the forward.
 *
 * Indexes:
 *   - (event_id) lookup for upsert / retry.
 *   - (status, last_attempt_at) lets the retry-failed cron pick up the
 *     oldest unsucceeded rows efficiently.
 *   - (deleted_at) Medusa soft-delete partial index, mirrors the
 *     soft-delete partial index pattern used on the other module tables.
 */
export class Migration20260507120000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            CREATE TABLE IF NOT EXISTS "erpnext_sync_event" (
                "id" TEXT NOT NULL,
                "event" TEXT NOT NULL,
                "event_id" TEXT NOT NULL,
                "payload" JSONB NULL,
                "status" TEXT NOT NULL DEFAULT 'pending',
                "attempts" INTEGER NOT NULL DEFAULT 0,
                "last_attempt_at" TIMESTAMPTZ NULL,
                "succeeded_at" TIMESTAMPTZ NULL,
                "last_error" TEXT NULL,
                "target_url" TEXT NULL,
                "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                "deleted_at" TIMESTAMPTZ NULL,
                CONSTRAINT "erpnext_sync_event_pkey" PRIMARY KEY ("id")
            );
        `)

        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_sync_event_event" ON "erpnext_sync_event" ("event") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_sync_event_event_id" ON "erpnext_sync_event" ("event_id") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_sync_event_status_last_attempt" ON "erpnext_sync_event" ("status", "last_attempt_at") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_sync_event_deleted_at" ON "erpnext_sync_event" ("deleted_at") WHERE deleted_at IS NULL;`,
        )
    }

    async down(): Promise<void> {
        this.addSql(`DROP TABLE IF EXISTS "erpnext_sync_event" CASCADE;`)
    }
}
