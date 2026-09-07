import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"

/**
 * GET /admin/erpnext/doctypes/:name/options?field=item_group
 *
 * What one ERPNext field will accept, read from the connected site rather
 * than from anything shipped in this plugin. A Select answers with its own
 * options; a Link answers with the records that exist there now; anything
 * else answers with an empty list, meaning free text.
 *
 * Used by the fixed-value inputs in the mapping wizard. The values that
 * belong there are that deployment's data — its Item Groups, its UOMs —
 * so offering a list this application decided on would be one client's
 * setup shipped to every other client.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const doctype = req.params.name
    const field = String((req.query as any).field ?? "").trim()
    if (!field) {
        res.status(400).json({ ok: false, message: "field is required" })
        return
    }

    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const result = await erpnext.fieldOptions(doctype, field)
    // A field whose options cannot be read is not a server fault: it is
    // usually Frappe being unreachable or the api key lacking permission.
    // 502 so the UI points at Settings instead of showing an empty list as
    // though the DocType genuinely had no choices.
    res.status(result.ok ? 200 : 502).json(result)
}
