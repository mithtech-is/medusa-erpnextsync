import { Migration } from "@mikro-orm/migrations"

/**
 * The Medusa half of the two-sided hard reset.
 *
 * Each side generates a secret, shows it once, and has to be handed the
 * other's. This table holds what that side needs to remember: the hash of
 * its own secret, when it dies, whether it has been spent, and which of
 * the two proofs have arrived.
 *
 * `secret_hash` is a hash and nothing else. The plaintext is returned once
 * to whoever asked and stored nowhere, so a row here is worth nothing to
 * anyone who reads it after the three minutes are up.
 */
export class Migration20260905120000 extends Migration {
    async up(): Promise<void> {
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
        // Verifying looks a secret up among the live requests, which is a
        // short list and a hot moment: three minutes, and somebody waiting.
        this.addSql(`
            CREATE INDEX IF NOT EXISTS "IDX_erpnext_reset_request_status"
                ON "erpnext_reset_request" ("status")
                WHERE "deleted_at" IS NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`DROP TABLE IF EXISTS "erpnext_reset_request" CASCADE;`)
    }
}
