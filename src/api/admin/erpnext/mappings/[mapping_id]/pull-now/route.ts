import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/mappings/:mapping_id/pull-now
 *
 * Trigger a one-shot pull for this mapping immediately (instead of
 * waiting for the next cron tick). Useful for verifying a fresh
 * mapping does what the operator expects.
 *
 * Body: optional { full?: boolean } — when true, clears `last_pull_at`
 * before running so the pull does a complete scan instead of an
 * incremental one.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { mapping_id } = req.params as { mapping_id: string }
    const body = (req.body ?? {}) as { full?: boolean }
    try {
        const mapping = await erpnext.getMapping(mapping_id)
        if (!mapping) {
            res.status(404).json({ ok: false, message: "mapping not found" })
            return
        }
        if (body.full) {
            // Reset the watermark so the next pull is a full scan.
            await erpnext.saveMapping({
                ...mapping,
                last_pull_at: null,
            })
            mapping.last_pull_at = null
        }
        const outcome = await erpnext.pullFromMapping({
            mapping,
            container: req.scope,
        })
        res.json(outcome)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "pull_now_failed",
        })
    }
}
