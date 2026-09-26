import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * POST /admin/erpnext/setup — "Set up ERPNext".
 *
 * Creates, over REST, everything this plugin needs on the ERPNext side:
 * the `medusa_sync` Check field and the two Frappe Webhooks on every
 * selection DocType, signed with a secret this store generates. Safe to
 * run again; each item reports created / updated / unchanged / error.
 *
 * Needs the ERPNext URL and an API key whose user has System Manager,
 * and a Medusa public URL for the Webhooks to POST to (the settings row,
 * else MEDUSA_BACKEND_URL, else Medusa's own admin backendUrl).
 *
 * 200 with the report even when an item failed — the report says which;
 * 400 only when nothing could be attempted.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    let fallbackPublicUrl: string | null = null
    try {
        const configModule: any = req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE)
        fallbackPublicUrl = configModule?.admin?.backendUrl ?? null
    } catch {
        fallbackPublicUrl = null
    }
    try {
        const result = await erpnext.setupErpnext({ fallbackPublicUrl })
        if (!result.report) {
            res.status(400).json({ ok: false, message: result.message ?? "setup could not start" })
            return
        }
        res.json(result)
    } catch (err: any) {
        res.status(500).json({ ok: false, message: err?.message ?? "setup_failed" })
    }
}
