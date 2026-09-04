import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/reset/confirm
 *
 * Prove to ERPNext that this side holds the secret ERPNext generated. The
 * secret goes back over the ordinary signed channel and only ERPNext's
 * answer counts; a refusal here means ERPNext did not recognise it, not
 * that anything went wrong in transit.
 *
 * Body: { id: string, secret: string }
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const body = (req.body ?? {}) as { id?: string; secret?: string }
    if (!body.id || !body.secret) {
        res.status(400).json({ ok: false, message: "id and secret are required" })
        return
    }
    try {
        const out = await erpnext.confirmRemoteReset(body.id, body.secret)
        res.status(out.ok ? 200 : 400).json(out)
    } catch (err: any) {
        res.status(500).json({ ok: false, message: err?.message ?? "reset_confirm_failed" })
    }
}
