import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * GET /admin/erpnext/mappings/suggest?entity=customer&doctype=Customer
 *
 * Returns the canonical mapping suggestion (if any) for the picked
 * (entity, doctype) pair. The admin Mapping editor calls this when
 * the operator clicks "Suggest field pairs" — it pre-fills the form
 * so the operator doesn't have to remember every store-specific
 * Custom Field name.
 *
 * Response shape:
 *   - { ok: true, canonical: true,  suggestion: {...} } — exact match found
 *   - { ok: true, canonical: false, suggestion: null  } — no entry; UI may
 *                                                          fall back to a
 *                                                          name-similarity
 *                                                          heuristic
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const entity = String(req.query.entity ?? "").trim()
    const doctype = String(req.query.doctype ?? "").trim()
    if (!entity || !doctype) {
        res.status(400).json({
            ok: false,
            message: "entity and doctype query params are required",
        })
        return
    }
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const result = await erpnext.suggestMappingForPair(entity, doctype)
        res.json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "suggest_failed",
        })
    }
}
