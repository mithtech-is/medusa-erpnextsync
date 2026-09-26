import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/stock-prices/refresh
 *
 * Re-read stock and selling prices from ERPNext now: for the Item codes
 * given, or for every linked Item when none are. What the hourly
 * reconcile does, on demand.
 */
const Body = z.object({ item_codes: z.array(z.string().min(1)).max(500).optional() })

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const parsed = Body.safeParse(req.body ?? {})
    if (!parsed.success) {
        return res.status(400).json({ ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") })
    }
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const codes = parsed.data.item_codes ?? []
    const result = codes.length
        ? await erpnext.refreshStockAndPrices(req.scope, codes)
        : await erpnext.reconcileStockAndPrices(req.scope)
    return res.json({ ok: (result?.failed ?? 0) === 0, ...result })
}
