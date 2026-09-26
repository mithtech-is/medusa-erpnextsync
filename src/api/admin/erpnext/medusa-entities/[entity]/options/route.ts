import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"

/**
 * GET /admin/erpnext/medusa-entities/:entity/options?path=status
 *
 * The known values for a Medusa target path, for the mapper's fixed and
 * default value pickers: a product's status, the store's sales channels,
 * shipping profiles, collections and types. `options: null` means the
 * path takes free text.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { entity } = req.params as { entity: string }
    const path = String((req.query as any)?.path ?? "").trim()
    if (!path) {
        res.status(400).json({ ok: false, message: "path is required" })
        return
    }
    try {
        const options = await erpnext.medusaOptions(entity, path, req.scope)
        res.json({ ok: true, entity, path, options })
    } catch (err: any) {
        res.status(500).json({ ok: false, message: err?.message ?? "options_failed" })
    }
}
