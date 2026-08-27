import { Migration } from "@mikro-orm/migrations"

/**
 * Configurable triggers, explicit create/update permissions, and log
 * retention.
 *
 * All columns are additive with defaults chosen so existing rows keep
 * behaving exactly as they do today:
 *
 *   - `trigger_preset` defaults to 'always' and `trigger_condition` to
 *     NULL, i.e. no extra filtering. The Customer mapping is separately
 *     moved onto the 'kyc_verified' preset by the same deploy, because
 *     that gate used to be hard-coded in the forwarder and dropping it
 *     silently would push every unverified customer to ERPNext.
 *   - `allow_create` / `allow_update` default to true, which is what
 *     the upsert already did unconditionally.
 *   - `skip_unchanged` defaults to false — today every matching event
 *     pushes, even when the payload is identical.
 *   - `log_retention_days` defaults to 180. Nothing pruned sync events
 *     before this, so the first run of the new cron will delete rows
 *     older than six months; the oldest row on prod is from May, which
 *     is inside that window.
 *
 * NB the class name is deliberately not a round timestamp — mikro-orm
 * tracks migrations by CLASS NAME across one shared table for every
 * module, so a collision means one of them is silently skipped while
 * `db:migrate` still reports success.
 */
export class Migration20260812143512 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_mapping"
                ADD COLUMN IF NOT EXISTS "trigger_preset"    TEXT NOT NULL DEFAULT 'always',
                ADD COLUMN IF NOT EXISTS "trigger_condition" TEXT NULL,
                ADD COLUMN IF NOT EXISTS "skip_unchanged"    BOOLEAN NOT NULL DEFAULT FALSE,
                ADD COLUMN IF NOT EXISTS "allow_create"      BOOLEAN NOT NULL DEFAULT TRUE,
                ADD COLUMN IF NOT EXISTS "allow_update"      BOOLEAN NOT NULL DEFAULT TRUE;
        `)
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "log_retention_days" INTEGER NOT NULL DEFAULT 180;
        `)
        this.addSql(`
            ALTER TABLE "erpnext_sync_event"
                ADD COLUMN IF NOT EXISTS "action"       TEXT NULL,
                ADD COLUMN IF NOT EXISTS "payload_hash" TEXT NULL;
        `)
        // The skip-unchanged lookup is "latest successful row for this
        // mapping + this record", so index the columns it filters on.
        this.addSql(`
            CREATE INDEX IF NOT EXISTS "IDX_erpnext_sync_event_mapping_hash"
                ON "erpnext_sync_event" ("mapping_id", "payload_hash")
                WHERE deleted_at IS NULL;
        `)
        // Preserve today's behaviour: the customer push was gated on
        // KYC in code. Move that onto the row so it stays true, and so
        // an operator can SEE it and change it.
        this.addSql(`
            UPDATE "erpnext_mapping"
               SET "trigger_preset"    = 'kyc_verified',
                   "trigger_condition" = 'metadata.kyc_fully_approved_at is set'
             WHERE "medusa_entity" = 'customer'
               AND "trigger_preset" = 'always'
               AND "trigger_condition" IS NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`DROP INDEX IF EXISTS "IDX_erpnext_sync_event_mapping_hash";`)
        this.addSql(`
            ALTER TABLE "erpnext_sync_event"
                DROP COLUMN IF EXISTS "action",
                DROP COLUMN IF EXISTS "payload_hash";
        `)
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                DROP COLUMN IF EXISTS "log_retention_days";
        `)
        this.addSql(`
            ALTER TABLE "erpnext_mapping"
                DROP COLUMN IF EXISTS "trigger_preset",
                DROP COLUMN IF EXISTS "trigger_condition",
                DROP COLUMN IF EXISTS "skip_unchanged",
                DROP COLUMN IF EXISTS "allow_create",
                DROP COLUMN IF EXISTS "allow_update";
        `)
    }
}
