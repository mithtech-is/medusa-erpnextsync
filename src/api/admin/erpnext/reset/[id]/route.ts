import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * GET /admin/erpnext/reset/:id
 *
 * Where this reset stands: which of the two proofs have arrived, how many
 * seconds the secret has left, and whether both hands are on the switch.
 * Never returns the secret or its hash.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { id } = req.params as { id: string }
    try {
        const out = await erpnext.resetStatus(id)
        res.status(out.ok ? 200 : 404).json(out)
    } catch (err: any) {
        res.status(500).json({ ok: false, message: err?.message ?? "reset_status_failed" })
    }
}
