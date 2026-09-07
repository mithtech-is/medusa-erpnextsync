import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { discoverEntityFields } from "../../../../../../modules/erpnext/discovery-runtime"

/**
 * GET /admin/erpnext/medusa-entities/:entity/fields
 *
 * The Medusa half of the two-panel mapper's field picker — the mirror of
 * `GET /admin/erpnext/doctypes/:name` on the Frappe side, which derives its
 * list from `frappe.get_meta`.
 *
 * The list is derived from the module's own model definition and merged
 * under the curated labels and transforms in `registry.ts`, so a column
 * added by a Medusa release or by a client's own module is offered without
 * anyone maintaining a list. `fields_source` says where the derived half
 * came from: `model` normally, `record` when a model could not be
 * introspected and one row was walked instead, `curated` when neither
 * worked and only `registry.ts` contributed.
 *
 * `?refresh=1` recomputes rather than reading the process cache. A model
 * cannot change without a redeploy, so this is for developing against a
 * module being edited, not for normal use.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const entityKey = req.params.entity
    const refresh = req.query.refresh === "1" || req.query.refresh === "true"

    const result = await discoverEntityFields(req.scope, entityKey, { refresh })
    if (!result) {
        res.status(404).json({
            message: `No Medusa entity named "${entityKey}" is in the registry.`,
        })
        return
    }

    res.json(result)
}
