import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * GET /admin/erpnext/doctypes/:name
 *
 * Return the field meta for one doctype via Frappe's
 * `frappe.client.get_meta`. The admin field-mapper calls this when
 * the operator picks a doctype on the right side of the editor —
 * the response populates the per-field dropdown.
 *
 * Response shape:
 *   {
 *     ok: boolean,
 *     fields: Array<{ fieldname, label, fieldtype, reqd, options, ... }>,
 *     message?: string
 *   }
 *
 * Results are cached server-side per process for 5 minutes — see
 * the meta cache in modules/erpnext/index.ts.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { name } = req.params as { name: string }
    if (!name) {
        res.status(400).json({ ok: false, message: "doctype name is required" })
        return
    }
    try {
        const result = await erpnext.getDoctypeMeta(name)
        if (!result.ok) {
            res.status(502).json(result)
            return
        }
        res.json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "doctype_meta_failed",
        })
    }
}
