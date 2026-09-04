import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/events/retry-failed
 *
 * Send again everything that gave up. For the morning after an outage:
 * the cause is fixed and nobody wants to click through a hundred rows.
 *
 * Goes through the same `retryEvent` the single-row button uses, one row
 * at a time, so the payload, the signing and the logging are the ordinary
 * ones. The thing people reach for when something is already wrong is the
 * worst possible place to keep a second implementation of the sync.
 *
 * Rehearsals are never re-sent — `listFailedForRetry` excludes them — and
 * that is deliberate: the payload in a test row was made up, and putting
 * it on the wire for real is the opposite of what a dry run is for.
 *
 * Body: { limit?: number }   default 50, capped at 500
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const body = (req.body ?? {}) as { limit?: number }
    const limit = Math.max(1, Math.min(Number(body.limit ?? 50) || 50, 500))
    try {
        const rows = await erpnext.listFailedForRetry(limit)
        const results: any[] = []
        for (const row of rows as any[]) {
            const outcome = await erpnext.retryEvent(row.event_id, req.scope)
            results.push({
                event_id: row.event_id,
                event: row.event,
                ok: outcome?.status === "success",
                status: outcome?.status,
                error: outcome?.error ?? null,
            })
        }
        res.json({
            ok: true,
            attempted: results.length,
            succeeded: results.filter((r) => r.ok).length,
            results,
        })
    } catch (err: any) {
        res.status(500).json({ ok: false, message: err?.message ?? "retry_failed" })
    }
}
