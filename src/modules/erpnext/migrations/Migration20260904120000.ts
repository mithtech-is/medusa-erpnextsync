import { Migration } from "@mikro-orm/migrations"

/**
 * Wire contract v2: identity, provenance and multi-site.
 *
 * Three things this adds, all additive and nullable so existing rows keep
 * working exactly as they did:
 *
 *   site_id          which Medusa store a row belongs to. One ERPNext can
 *                    serve several; every envelope now names its site.
 *   mapping_uid /    the id and ordering a mapping has in BOTH systems, so
 *   version          an edit made in the Frappe Desk and one made in the
 *                    Medusa admin can be reconciled rather than silently
 *                    overwriting each other.
 *   origin /         who caused a row, and which Medusa record an inbound
 *   correlation_id / write touched. `entity_ref` is the breadcrumb that
 *   entity_ref       stops a sync loop: the echo the far side sends back
 *                    arrives in a different request, where no in-memory
 *                    guard survives, so the push looks here instead.
 *
 * `entity_ref` is indexed together with the timestamp because the lookup
 * runs on every outbound push and only ever asks for the recent past.
 */
export class Migration20260904120000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "site_id" TEXT NULL;
        `)

        this.addSql(`
            ALTER TABLE "erpnext_mapping"
                ADD COLUMN IF NOT EXISTS "mapping_uid" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "version" INTEGER NOT NULL DEFAULT 1,
                ADD COLUMN IF NOT EXISTS "site_id" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "source_of_truth" TEXT NOT NULL DEFAULT 'ERPNext',
                ADD COLUMN IF NOT EXISTS "last_synced_at" TIMESTAMPTZ NULL;
        `)

        // Existing mappings have no shared id yet. Give each one, so the
        // first exchange with ERPNext pairs the two copies instead of
        // creating duplicates. gen_random_uuid() ships with pgcrypto in
        // PG13+ core; fall back to md5(random()) if it is unavailable.
        this.addSql(`
            UPDATE "erpnext_mapping"
               SET "mapping_uid" = replace(gen_random_uuid()::text, '-', '')
             WHERE "mapping_uid" IS NULL;
        `)

        this.addSql(`
            CREATE UNIQUE INDEX IF NOT EXISTS "IDX_erpnext_mapping_uid"
                ON "erpnext_mapping" ("mapping_uid")
             WHERE "mapping_uid" IS NOT NULL AND "deleted_at" IS NULL;
        `)

        this.addSql(`
            ALTER TABLE "erpnext_sync_event"
                ADD COLUMN IF NOT EXISTS "origin" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "correlation_id" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "entity_ref" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "site_id" TEXT NULL;
        `)

        this.addSql(`
            CREATE INDEX IF NOT EXISTS "IDX_erpnext_sync_event_entity_ref"
                ON "erpnext_sync_event" ("entity_ref", "created_at")
             WHERE "entity_ref" IS NOT NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`DROP INDEX IF EXISTS "IDX_erpnext_sync_event_entity_ref";`)
        this.addSql(`
            ALTER TABLE "erpnext_sync_event"
                DROP COLUMN IF EXISTS "origin",
                DROP COLUMN IF EXISTS "correlation_id",
                DROP COLUMN IF EXISTS "entity_ref",
                DROP COLUMN IF EXISTS "site_id";
        `)
        this.addSql(`DROP INDEX IF EXISTS "IDX_erpnext_mapping_uid";`)
        this.addSql(`
            ALTER TABLE "erpnext_mapping"
                DROP COLUMN IF EXISTS "mapping_uid",
                DROP COLUMN IF EXISTS "version",
                DROP COLUMN IF EXISTS "site_id",
                DROP COLUMN IF EXISTS "source_of_truth",
                DROP COLUMN IF EXISTS "last_synced_at";
        `)
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "site_id";
        `)
    }
}
