import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * GET /admin/erpnext/reconcile
 *
 * On-demand reconciliation report across the reconcilable entities
 * (customer / product / order). For each, compares the live Medusa ids
 * (with a natural-key fallback) against what ERPNext has, and returns
 * the divergence — `missing_on_frappe` (in Medusa, not in ERPNext) and
 * `frappe_orphans` (stamped with a Medusa id ERPNext still has but Medusa
 * no longer does). Report-only; makes no changes on either side.
 *
 * Query: ?limit=<n> (per-side row cap, default 2000) & ?sample=<n>
 * (max ids listed per bucket, default 100).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const q = req.query as Record<string, string | undefined>
    const limit = q.limit ? Math.max(1, Math.min(10000, Number(q.limit))) : undefined
    const sample = q.sample ? Math.max(1, Math.min(1000, Number(q.sample))) : undefined

    try {
        const report = await erpnext.reconcileAll(req.scope, { limit, sample })
        res.json(report)
    } catch (err: any) {
        res.status(500).json({ ok: false, error: err?.message ?? "reconcile failed" })
    }
}
