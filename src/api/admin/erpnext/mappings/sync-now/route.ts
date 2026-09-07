import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/mappings/sync-now
 *
 * Send every mapping to ERPNext. A mapping travels when it is saved and
 * nothing else moves the list, so an ERPNext connected later, or one
 * that lost a mapping, reads a shorter list than this side until
 * somebody presses this. The receiver keeps its newer copies, so it is
 * safe to press twice.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const result = await erpnext.pushAllMappingConfigs()
        res.json({ ok: true, ...result })
    } catch (err: any) {
        res.status(500).json({ ok: false, message: err?.message ?? "sync_now_failed" })
    }
}
