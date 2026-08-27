import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * GET /admin/erpnext/doctypes
 *
 * List Frappe doctypes available to the configured api_key. Used by
 * the admin field-mapper to populate the doctype dropdown.
 *
 * Query:
 *   ?search=<substring>     — filter by name LIKE (Frappe-side)
 *   ?include_single=true    — include Singles (default false)
 *   ?limit=<n>              — page size; clamped to [1, 2000], default 500
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const q = req.query as Record<string, any>
    try {
        const result = await erpnext.listFrappeDoctypes({
            search: q.search ? String(q.search) : undefined,
            include_single: q.include_single === "true",
            limit: q.limit ? Number(q.limit) : undefined,
        })
        if (!result.ok) {
            res.status(502).json(result)
            return
        }
        res.json({ items: result.items ?? [] })
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "doctype_list_failed",
        })
    }
}
