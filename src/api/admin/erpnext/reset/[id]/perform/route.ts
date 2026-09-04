import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/reset/:id/perform
 *
 * Do it. Refuses unless both sides have proved themselves, so this route
 * cannot be the whole story for anyone who reaches it.
 *
 * Clears the sync event log and switches off every mapping. Keeps every
 * product, customer and order, and every ERPNext id recorded on them: a
 * reset that took those with it would leave both systems holding the same
 * records and no longer knowing it.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { id } = req.params as { id: string }
    try {
        const report = await erpnext.performReset(id)
        res.json({ ok: true, id, report })
    } catch (err: any) {
        res.status(400).json({ ok: false, message: err?.message ?? "reset_failed" })
    }
}
