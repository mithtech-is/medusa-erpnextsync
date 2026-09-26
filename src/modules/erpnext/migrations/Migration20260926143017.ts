import { Migration } from "@mikro-orm/migrations"

/**
 * medusync is retired: ERPNext → Medusa now arrives through Frappe core
 * Webhooks, selection is the `medusa_sync` Check field, and the map from
 * an ERPNext document to a Medusa record lives here, in `erpnext_link`,
 * with the direction the document last showed.
 *
 * What changes on the settings row: the medusync pairing (`site_id`,
 * `frappe_receive_method`, the Medusa→Frappe `webhook_secret`) goes; the
 * Frappe→Medusa secret keeps its value under its real name,
 * `frappe_webhook_secret`; `products_doctype` becomes the first entry of
 * `sync_doctypes`, in allow mode, so nothing becomes eligible to sync
 * until somebody ticks it. The mapping and event provenance columns that
 * only the envelope wrote go too, and so does the two-sided reset.
 *
 * Class name is not a round timestamp on purpose: mikro-orm tracks
 * migrations by class name in one table shared by every module.
 */
export class Migration20260926143017 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            CREATE TABLE IF NOT EXISTS "erpnext_link" (
                "id"            text NOT NULL,
                "doctype"       text NOT NULL,
                "erpnext_name"  text NOT NULL,
                "medusa_entity" text NOT NULL,
                "medusa_id"     text NOT NULL,
                "mapping_id"    text NULL,
                "state"         text NOT NULL DEFAULT 'active',
                "remote_direction" text NULL,
                "last_seen_at"  timestamptz NULL,
                "created_at"    timestamptz NOT NULL DEFAULT now(),
                "updated_at"    timestamptz NOT NULL DEFAULT now(),
                "deleted_at"    timestamptz NULL,
                CONSTRAINT "erpnext_link_pkey" PRIMARY KEY ("id")
            );
        `)
        this.addSql(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_erpnext_link_remote" ON "erpnext_link" ("doctype", "erpnext_name", "medusa_entity") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_link_medusa" ON "erpnext_link" ("medusa_entity", "medusa_id") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_link_state" ON "erpnext_link" ("doctype", "medusa_entity", "state") WHERE deleted_at IS NULL;`,
        )

        // The Frappe→Medusa secret keeps its value under its real name.
        this.addSql(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name = 'erpnext_setting' AND column_name = 'frappe_to_medusa_secret')
                   AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name = 'erpnext_setting' AND column_name = 'frappe_webhook_secret') THEN
                    ALTER TABLE "erpnext_setting" RENAME COLUMN "frappe_to_medusa_secret" TO "frappe_webhook_secret";
                END IF;
            END $$;
        `)
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "frappe_webhook_secret" text NULL,
                ADD COLUMN IF NOT EXISTS "medusa_public_url" text NULL,
                ADD COLUMN IF NOT EXISTS "sync_doctypes" jsonb NULL,
                ADD COLUMN IF NOT EXISTS "erpnext_setup_at" timestamptz NULL,
                ADD COLUMN IF NOT EXISTS "erpnext_setup_report" jsonb NULL,
                ADD COLUMN IF NOT EXISTS "phone_region" text NOT NULL DEFAULT 'IN';
        `)
        // Allow mode: the Check field defaults to 0, so an existing catalogue
        // stays out of the store until its documents are ticked.
        this.addSql(`
            UPDATE "erpnext_setting"
               SET "sync_doctypes" = jsonb_build_array(
                       jsonb_build_object(
                           'doctype', COALESCE(NULLIF(btrim("products_doctype"), ''), 'Item'),
                           'mode', 'allow'
                       )
                   )
             WHERE "sync_doctypes" IS NULL;
        `)
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "site_id",
                DROP COLUMN IF EXISTS "frappe_receive_method",
                DROP COLUMN IF EXISTS "webhook_secret",
                DROP COLUMN IF EXISTS "products_doctype";
        `)
        this.addSql(`
            ALTER TABLE "erpnext_mapping"
                DROP COLUMN IF EXISTS "site_id",
                DROP COLUMN IF EXISTS "source_of_truth",
                DROP COLUMN IF EXISTS "last_synced_at";
        `)
        this.addSql(`
            ALTER TABLE "erpnext_sync_event"
                DROP COLUMN IF EXISTS "origin",
                DROP COLUMN IF EXISTS "correlation_id",
                DROP COLUMN IF EXISTS "site_id";
        `)
        this.addSql(`DROP INDEX IF EXISTS "IDX_erpnext_reset_request_status";`)
        this.addSql(`DROP TABLE IF EXISTS "erpnext_reset_request" CASCADE;`)
    }

    /** Shapes only: what the dropped columns held is not recoverable. */
    async down(): Promise<void> {
        this.addSql(`
            CREATE TABLE IF NOT EXISTS "erpnext_reset_request" (
                "id"                  TEXT NOT NULL,
                "site_id"             TEXT NULL,
                "status"              TEXT NOT NULL DEFAULT 'pending',
                "secret_hash"         TEXT NULL,
                "expires_at"          TIMESTAMPTZ NULL,
                "used_at"             TIMESTAMPTZ NULL,
                "local_verified_at"   TIMESTAMPTZ NULL,
                "remote_confirmed_at" TIMESTAMPTZ NULL,
                "completed_at"        TIMESTAMPTZ NULL,
                "report"              JSONB NULL,
                "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                "deleted_at"          TIMESTAMPTZ NULL,
                CONSTRAINT "erpnext_reset_request_pkey" PRIMARY KEY ("id")
            );
        `)
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_reset_request_status" ON "erpnext_reset_request" ("status") WHERE "deleted_at" IS NULL;`,
        )
        this.addSql(`
            ALTER TABLE "erpnext_sync_event"
                ADD COLUMN IF NOT EXISTS "origin" text NULL,
                ADD COLUMN IF NOT EXISTS "correlation_id" text NULL,
                ADD COLUMN IF NOT EXISTS "site_id" text NULL;
        `)
        this.addSql(`
            ALTER TABLE "erpnext_mapping"
                ADD COLUMN IF NOT EXISTS "site_id" text NULL,
                ADD COLUMN IF NOT EXISTS "source_of_truth" text NOT NULL DEFAULT 'ERPNext',
                ADD COLUMN IF NOT EXISTS "last_synced_at" timestamptz NULL;
        `)
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "site_id" text NULL,
                ADD COLUMN IF NOT EXISTS "frappe_receive_method" text NULL,
                ADD COLUMN IF NOT EXISTS "webhook_secret" text NULL,
                ADD COLUMN IF NOT EXISTS "products_doctype" text NULL;
        `)
        this.addSql(`
            UPDATE "erpnext_setting"
               SET "products_doctype" = "sync_doctypes"->0->>'doctype'
             WHERE "products_doctype" IS NULL AND "sync_doctypes" IS NOT NULL;
        `)
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "medusa_public_url",
                DROP COLUMN IF EXISTS "sync_doctypes",
                DROP COLUMN IF EXISTS "erpnext_setup_at",
                DROP COLUMN IF EXISTS "erpnext_setup_report",
                DROP COLUMN IF EXISTS "phone_region";
        `)
        this.addSql(`
            DO $$ BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name = 'erpnext_setting' AND column_name = 'frappe_webhook_secret')
                   AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                           WHERE table_name = 'erpnext_setting' AND column_name = 'frappe_to_medusa_secret') THEN
                    ALTER TABLE "erpnext_setting" RENAME COLUMN "frappe_webhook_secret" TO "frappe_to_medusa_secret";
                END IF;
            END $$;
        `)
        this.addSql(`DROP INDEX IF EXISTS "IDX_erpnext_link_state";`)
        this.addSql(`DROP INDEX IF EXISTS "IDX_erpnext_link_medusa";`)
        this.addSql(`DROP INDEX IF EXISTS "UQ_erpnext_link_remote";`)
        this.addSql(`DROP TABLE IF EXISTS "erpnext_link";`)
    }
}
