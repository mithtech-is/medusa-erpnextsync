import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * GET /admin/erpnext/studio/sample?entity=product&id=prod_123
 *
 * A record of this entity to reason about while writing a mapping: the
 * real one when an id is given, otherwise one built from the entity's own
 * declared paths. A brand-new mapping is exactly when a sample is most
 * useful and exactly when there may be nothing yet to sample.
 *
 * NB the folder is `studio`, not `test`. Medusa's plugin compiler drops
 * any folder named `test` from the built output — the route file exists,
 * the build succeeds, and every call returns 404. See the note on
 * mappings/[mapping_id]/dry-run.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const query = req.query as { entity?: string; id?: string }
    const entity = String(query.entity ?? "").trim()
    if (!entity) {
        res.status(400).json({ ok: false, message: "entity is required" })
        return
    }
    try {
        const sample = await erpnext.sampleFor(entity, req.scope, query.id ?? null)
        res.json({ ok: true, ...sample })
    } catch (err: any) {
        res.status(400).json({ ok: false, message: err?.message ?? "sample_failed" })
    }
}
