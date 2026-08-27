import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * Admin mapping CRUD — list + create / update.
 *
 * Replaces the earlier Frappe-proxy variant. Storage is now Medusa-side
 * (`erpnext_mapping` table) so each mapping can carry its own field
 * pairs, transforms, direction, events, and pull cursor without
 * depending on a Frappe Single doctype to exist.
 *
 * GET   /admin/erpnext/mappings
 *         Returns every mapping row. Optional filters:
 *           ?enabled=true|false  ?medusa_entity=<key>  ?doctype=<name>
 *
 * POST  /admin/erpnext/mappings
 *         Body shape: see saveMapping() in modules/erpnext/index.ts.
 *         Omit `id` to create; include `id` to update. The service
 *         validates field_mappings and rejects malformed entries
 *         silently (admin form validates first).
 */

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const q = req.query as Record<string, any>
    const filter: any = {}
    if (q.enabled === "true") filter.enabled = true
    if (q.enabled === "false") filter.enabled = false
    if (q.medusa_entity) filter.medusa_entity = String(q.medusa_entity)
    if (q.doctype) filter.doctype = String(q.doctype)
    try {
        const rows = await erpnext.listMappings(filter)
        res.json({ items: rows, count: rows.length })
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "mappings_list_failed",
        })
    }
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const body = (req.body ?? {}) as Record<string, any>
    if (
        !body.name ||
        !body.medusa_entity ||
        !body.doctype ||
        !body.key_medusa_field
    ) {
        res.status(400).json({
            ok: false,
            message:
                "name, medusa_entity, doctype and key_medusa_field are required",
        })
        return
    }
    try {
        const userId = (req as any)?.auth_context?.actor_id ?? null
        const saved = await erpnext.saveMapping({
            ...body,
            updated_by_user_id: body.updated_by_user_id ?? userId,
        })
        res.json({ ok: true, mapping: saved })
    } catch (err: any) {
        // A bad trigger condition is operator error, not a server
        // fault — 400 so the form can show it inline instead of a
        // generic failure toast.
        const message = err?.message ?? "mapping_save_failed"
        res.status(/trigger_condition is invalid/.test(message) ? 400 : 500).json({
            ok: false,
            message,
        })
    }
}
