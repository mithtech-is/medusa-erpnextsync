import { Migration } from "@mikro-orm/migrations"

/**
 * A sync is its pair.
 *
 * Mappings carried a generated identity, and the shipped defaults a
 * `default:` one, so the same pair could exist twice on this side and
 * under two different identities across the two systems — which is how
 * one sync came to be listed as two. Every mapping now carries the
 * identity derived from what it pairs, `pair:<entity>:<doctype>`, and any
 * twins for one pair are folded into a single row: the higher version
 * survives, then the one switched on, then the older; the others' field
 * pairs and events are folded in and the rows soft-deleted. A unique index
 * then keeps it that way.
 *
 * The rule is inlined rather than imported from ../mapping-sync so this
 * migration means the same thing whatever that module becomes later.
 */
export class Migration20260907120000 extends Migration {
    async up(): Promise<void> {
        const scrub = (doctype: string) =>
            String(doctype ?? "")
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "")
        const pairOf = (r: any) => {
            const base = `pair:${String(r.medusa_entity ?? "").trim().toLowerCase()}:${scrub(r.doctype)}`
            return r.site_id ? `${base}:${r.site_id}` : base
        }
        const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`

        const rows: any[] = await this.execute(
            `SELECT id, name, mapping_uid, medusa_entity, doctype, site_id, version, enabled,
                    events, field_mappings, created_at
               FROM "erpnext_mapping"
              WHERE deleted_at IS NULL
              ORDER BY created_at ASC`,
        )

        const groups = new Map<string, any[]>()
        for (const r of rows) {
            const pair = pairOf(r)
            if (!groups.has(pair)) groups.set(pair, [])
            groups.get(pair)!.push(r)
        }

        for (const [pair, members] of groups) {
            const sorted = [...members].sort((a, b) => {
                const av = Number(a.version ?? 1)
                const bv = Number(b.version ?? 1)
                if (av !== bv) return bv - av
                if (Boolean(a.enabled) !== Boolean(b.enabled)) return a.enabled ? -1 : 1
                return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
            })
            const keeper = sorted[0]
            const twins = sorted.slice(1)

            let fields: any[] = Array.isArray(keeper.field_mappings) ? keeper.field_mappings : []
            let events: string[] = Array.isArray(keeper.events) ? keeper.events : []
            for (const t of twins) {
                const taken = new Set(fields.map((p) => p.erpnext_field))
                for (const p of Array.isArray(t.field_mappings) ? t.field_mappings : []) {
                    if (p?.erpnext_field && !taken.has(p.erpnext_field)) {
                        fields.push(p)
                        taken.add(p.erpnext_field)
                    }
                }
                for (const e of Array.isArray(t.events) ? t.events : []) {
                    if (e && !events.includes(e)) events.push(e)
                }
                this.addSql(`UPDATE "erpnext_mapping" SET deleted_at = now() WHERE id = '${t.id}';`)
            }

            if (twins.length) {
                this.addSql(
                    `UPDATE "erpnext_mapping"
                        SET mapping_uid = '${pair}', field_mappings = ${lit(fields)}, events = ${lit(events)},
                            version = ${Number(keeper.version ?? 1) + 1}, updated_at = now()
                      WHERE id = '${keeper.id}';`,
                )
            } else if (keeper.mapping_uid !== pair) {
                this.addSql(`UPDATE "erpnext_mapping" SET mapping_uid = '${pair}' WHERE id = '${keeper.id}';`)
            }
        }

        this.addSql(
            `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_erpnext_mapping_mapping_uid"
                ON "erpnext_mapping" ("mapping_uid") WHERE deleted_at IS NULL;`,
        )
    }

    async down(): Promise<void> {
        this.addSql(`DROP INDEX IF EXISTS "UQ_erpnext_mapping_mapping_uid";`)
    }
}
