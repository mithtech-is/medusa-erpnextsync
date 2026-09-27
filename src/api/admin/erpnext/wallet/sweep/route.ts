import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/wallet/sweep
 *
 * Push the store wallet's rows ERPNext does not hold yet, now — for one
 * customer or for everyone. What the five-minute job does, on demand.
 */
const Body = z.object({ customer_id: z.string().min(1).optional(), limit: z.number().int().min(1).max(500).optional() })

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const parsed = Body.safeParse(req.body ?? {})
    if (!parsed.success) {
        return res.status(400).json({ ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") })
    }
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const result = await erpnext.sweepWalletTransactions(req.scope, parsed.data)
    return res.json({ ok: (result?.failed ?? 0) === 0, ...result })
}
