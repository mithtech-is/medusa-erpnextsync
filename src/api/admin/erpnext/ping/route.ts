import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * POST /admin/erpnext/ping
 *
 * Verify the stored ERPNext URL + api_key / api_secret reach a real
 * Frappe instance. Hits Frappe's built-in
 *   GET /api/method/frappe.auth.get_logged_user
 * which echoes the user the keys belong to. The admin "Test connection"
 * button calls this.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const result = await erpnext.pingErpnext()
        res.json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "ping_failed",
        })
    }
}
