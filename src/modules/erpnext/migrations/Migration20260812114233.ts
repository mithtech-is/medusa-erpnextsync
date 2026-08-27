import { Migration } from "@mikro-orm/migrations"

/**
 * `erpnext_setting.push_allowlist` — outbound safety valve.
 *
 * Additive and nullable, so existing deployments keep their current
 * behaviour: NULL / empty means "no restriction", which is what every
 * row has the moment this runs.
 *
 * Purpose: pointing a production Medusa at a non-production ERPNext is
 * a normal step while integrating, but without a valve it streams every
 * customer's personal data onto that box. This column lets an operator
 * say "push only these records" without switching sync off entirely.
 *
 * NB the class name is deliberately NOT a round timestamp. There is one
 * shared `mikro_orm_migrations` table across every module and mikro-orm
 * tracks by CLASS NAME, so two modules that both pick e.g.
 * Migration20260812110000 collide and one is silently skipped while
 * `db:migrate` still reports success.
 */
export class Migration20260812114233 extends Migration {
    async up(): Promise<void> {
        this.addSql(`
            ALTER TABLE "erpnext_setting"
                ADD COLUMN IF NOT EXISTS "push_allowlist" TEXT NULL;
        `)
    }

    async down(): Promise<void> {
        this.addSql(
            `ALTER TABLE "erpnext_setting" DROP COLUMN IF EXISTS "push_allowlist";`,
        )
    }
}
