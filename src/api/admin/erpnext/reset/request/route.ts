import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/reset/request
 *
 * Start this side's half of a two-sided hard reset and return its secret,
 * once. The plaintext is in this response and nowhere else: not in the
 * table, not in the sync event log, not in a log line. If it is lost,
 * ask again — the old request is retired automatically, because two live
 * secrets mean an operator holding two slips of paper they cannot tell
 * apart.
 *
 * The secret lives three minutes and works once. Carry it to the ERPNext
 * side; bring theirs back here.
 *
 * Body: { site_id?: string }
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const body = (req.body ?? {}) as { site_id?: string }
    try {
        const out = await erpnext.requestReset(body.site_id ?? null)
        res.json({ ok: true, ...out })
    } catch (err: any) {
        res.status(500).json({ ok: false, message: err?.message ?? "reset_request_failed" })
    }
}
