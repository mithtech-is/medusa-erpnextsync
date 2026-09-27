import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * GET /admin/erpnext/links
 *
 * The documents that have synced: one row per ERPNext document ↔ Medusa
 * record, with the direction ERPNext last showed for it and whether the
 * Medusa side is active or drafted. Which documents *may* sync is decided
 * on the ERPNext side by the Sync to Medusa field; this is what has.
 *
 *   ?doctype=Item&entity=product&state=active&q=PANEL&limit=50&offset=0
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const q = req.query as Record<string, string | undefined>
    const limit = Math.max(1, Math.min(500, Number(q.limit ?? 50)))
    const offset = Math.max(0, Number(q.offset ?? 0))
    const filters: Record<string, any> = {}
    if (q.doctype) filters.doctype = q.doctype
    if (q.entity) filters.medusa_entity = q.entity
    if (q.state && ["active", "drafted"].includes(q.state)) filters.state = q.state
    if (q.q && q.q.trim()) {
        const like = `%${q.q.trim()}%`
        filters.$or = [{ erpnext_name: { $ilike: like } }, { medusa_id: { $ilike: like } }]
    }
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const [items, count] = await erpnext.listAndCountErpnextLinks(filters, {
            take: limit,
            skip: offset,
            order: { last_seen_at: "DESC", created_at: "DESC" },
        })
        const all: any[] = await erpnext.listErpnextLinks({}, { select: ["doctype", "medusa_entity"], take: 5000 })
        const doctypes = Array.from(new Set(all.map((l) => String(l.doctype)))).sort()
        const entities = Array.from(new Set(all.map((l) => String(l.medusa_entity)))).sort()
        res.json({
            items: items.map((l: any) => ({
                id: l.id,
                doctype: l.doctype,
                erpnext_name: l.erpnext_name,
                medusa_entity: l.medusa_entity,
                medusa_id: l.medusa_id,
                mapping_id: l.mapping_id ?? null,
                state: l.state,
                remote_direction: l.remote_direction ?? null,
                last_seen_at: l.last_seen_at ?? null,
                created_at: l.created_at,
            })),
            count,
            limit,
            offset,
            doctypes,
            entities,
        })
    } catch (err: any) {
        res.status(500).json({ ok: false, message: err?.message ?? "links_failed" })
    }
}
