import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/wallet/reconcile
 *
 * Compare every paired wallet's balance with ERPNext's now. Drift is
 * reported on the Events tab, never corrected here: ERPNext's figure is
 * authoritative and the correction is an Adjustment posted there.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const result = await erpnext.reconcileWallets(req.scope)
    return res.json({ ok: (result?.drift ?? 0) === 0, ...result })
}
