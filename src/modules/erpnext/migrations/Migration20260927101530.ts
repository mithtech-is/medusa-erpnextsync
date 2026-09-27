import { Migration } from "@mikro-orm/migrations"

/**
 * The selection mode (allow / deny list) moves from the Settings list
 * onto each sync; the Settings list is derived from the syncs.
 */
export class Migration20260927101530 extends Migration {
    async up(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_mapping" ADD COLUMN IF NOT EXISTS "selection_mode" text NULL;`)
        // Carry the modes the Settings list holds today onto the syncs
        // that pull those DocTypes, so nothing changes at the first setup.
        this.addSql(`
            UPDATE "erpnext_mapping" m
               SET "selection_mode" = sd.mode
              FROM (
                    SELECT (elem->>'doctype') AS doctype, COALESCE(elem->>'mode', 'allow') AS mode
                      FROM "erpnext_setting" s, jsonb_array_elements(COALESCE(s.sync_doctypes, '[]'::jsonb)) AS elem
                   ) sd
             WHERE m."doctype" = sd.doctype
               AND m."direction" IN ('pull', 'both')
               AND m."selection_mode" IS NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(`ALTER TABLE "erpnext_mapping" DROP COLUMN IF EXISTS "selection_mode";`)
    }
}
