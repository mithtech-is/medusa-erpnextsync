import { Migration } from "@mikro-orm/migrations"

/**
 * `erpnext_mapping` — operator-defined sync rules pairing a Medusa
 * entity with a Frappe doctype, with field-by-field transforms.
 *
 * Indexes:
 *   - (enabled, medusa_entity) covers the push subscriber's hot path
 *     ("which mappings care about this event?"); the subscriber
 *     filters by event name client-side from the JSON `events` array.
 *   - (enabled, direction) supports the pull cron picking pull/both
 *     rows in one pass.
 *   - (deleted_at) Medusa soft-delete partial, matches the rest of
 *     the plugin.
 */
export class Migration20260521000000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            CREATE TABLE IF NOT EXISTS "erpnext_mapping" (
                "id" TEXT NOT NULL,
                "name" TEXT NOT NULL,
                "description" TEXT NULL,
                "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
                "medusa_entity" TEXT NOT NULL,
                "doctype" TEXT NOT NULL,
                "direction" TEXT NOT NULL DEFAULT 'both',
                "events" JSONB NULL,
                "pull_filter" JSONB NULL,
                "pull_page_size" INTEGER NOT NULL DEFAULT 200,
                "key_medusa_field" TEXT NOT NULL,
                "key_erpnext_field" TEXT NOT NULL DEFAULT 'name',
                "field_mappings" JSONB NOT NULL DEFAULT '[]',
                "last_pull_at" TIMESTAMPTZ NULL,
                "last_pull_run_at" TIMESTAMPTZ NULL,
                "last_pull_error" TEXT NULL,
                "last_push_run_at" TIMESTAMPTZ NULL,
                "last_push_error" TEXT NULL,
                "updated_by_user_id" TEXT NULL,
                "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                "deleted_at" TIMESTAMPTZ NULL,
                CONSTRAINT "erpnext_mapping_pkey" PRIMARY KEY ("id")
            );
        `)

        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_mapping_enabled_entity" ON "erpnext_mapping" ("enabled", "medusa_entity") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_mapping_enabled_direction" ON "erpnext_mapping" ("enabled", "direction") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_mapping_doctype" ON "erpnext_mapping" ("doctype") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_mapping_deleted_at" ON "erpnext_mapping" ("deleted_at") WHERE deleted_at IS NULL;`,
        )

        // Add a `mapping_id` column to the sync-event log so individual
        // forwards can be traced back to the mapping that triggered
        // them. NULL for legacy-path forwards (when no mapping matches).
        this.addSql(`
            ALTER TABLE "erpnext_sync_event"
                ADD COLUMN IF NOT EXISTS "mapping_id" TEXT NULL;
        `)
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_sync_event_mapping_id" ON "erpnext_sync_event" ("mapping_id") WHERE deleted_at IS NULL AND mapping_id IS NOT NULL;`,
        )
    }

    async down(): Promise<void> {
        this.addSql(
            `ALTER TABLE "erpnext_sync_event" DROP COLUMN IF EXISTS "mapping_id";`,
        )
        this.addSql(`DROP TABLE IF EXISTS "erpnext_mapping" CASCADE;`)
    }
}
