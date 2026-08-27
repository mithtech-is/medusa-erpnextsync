import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/events/:event_id/retry
 *
 * Re-attempts a previously failed (or skipped) ERPNext forward. The
 * stored payload from the original attempt is reused — we do NOT
 * re-fetch the customer/order from Medusa. Rationale: the original
 * payload represents the entity state *at the moment the event fired*
 * (an order at "placed" time has different fields than the same order
 * after fulfillment), and replaying that exact snapshot is what the
 * Frappe-side webhook handler expects to see.
 *
 * Idempotency: the Frappe receiver dedupes on x-medusa-event-id, so a
 * retry that succeeds after the original eventually went through too
 * is a no-op (logged as `deduped: true` on the Frappe side).
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const { event_id } = req.params as { event_id: string }
    if (!event_id) {
        res.status(400).json({ message: "event_id required" })
        return
    }

    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    // Pass the request scope so an inbound event can be re-applied via the
    // inbound dispatcher (needs to resolve target modules).
    const result = await erpnext.retryEvent(event_id, req.scope)

    if (!result.ok) {
        // 422 — the row doesn't exist or the retry itself failed. The
        // row's `last_error` will hold the detail; surface it here for
        // the admin UI to display inline.
        res.status(422).json({
            ok: false,
            event_id,
            error: result.error ?? "retry failed",
            httpStatus: result.httpStatus,
        })
        return
    }
    res.json({ ok: true, event_id, status: result.status })
}
