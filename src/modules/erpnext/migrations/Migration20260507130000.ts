import { Migration } from "@mikro-orm/migrations"

/**
 * `erpnext_setting` — singleton settings row for the ERPNext sync.
 *
 * Enforced single-row semantics via UNIQUE index on `singleton_key`
 * (only "default" is ever inserted). The application service uses a
 * conditional INSERT-or-UPDATE around that key.
 */
export class Migration20260507130000 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            CREATE TABLE IF NOT EXISTS "erpnext_setting" (
                "id" TEXT NOT NULL,
                "singleton_key" TEXT NOT NULL DEFAULT 'default',
                "enable_sync" BOOLEAN NOT NULL DEFAULT TRUE,
                "erpnext_url" TEXT NULL,
                "webhook_secret" TEXT NULL,
                "erpnext_api_key" TEXT NULL,
                "erpnext_api_secret" TEXT NULL,
                "request_timeout_ms" INTEGER NOT NULL DEFAULT 15000,
                "auto_retry_failed" BOOLEAN NOT NULL DEFAULT TRUE,
                "auto_retry_max_attempts" INTEGER NOT NULL DEFAULT 5,
                "auto_retry_min_interval_minutes" INTEGER NOT NULL DEFAULT 15,
                "last_full_resync_at" TIMESTAMPTZ NULL,
                "notes" TEXT NULL,
                "updated_by_user_id" TEXT NULL,
                "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
                "deleted_at" TIMESTAMPTZ NULL,
                CONSTRAINT "erpnext_setting_pkey" PRIMARY KEY ("id")
            );
        `)

        this.addSql(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_erpnext_setting_singleton_key" ON "erpnext_setting" ("singleton_key") WHERE deleted_at IS NULL;`,
        )
        this.addSql(
            `CREATE INDEX IF NOT EXISTS "IDX_erpnext_setting_deleted_at" ON "erpnext_setting" ("deleted_at") WHERE deleted_at IS NULL;`,
        )
    }

    async down(): Promise<void> {
        this.addSql(`DROP TABLE IF EXISTS "erpnext_setting" CASCADE;`)
    }
}
