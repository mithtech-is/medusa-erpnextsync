import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * GET /admin/erpnext/events
 *
 * List rows from `erpnext_sync_event`. Supports:
 *   ?status=pending|success|failed|skipped   (default: all)
 *   ?event=customer.created                  (exact match on event name)
 *   ?limit=50  (default 50, max 500)
 *   ?offset=0
 *
 * Sorted by `last_attempt_at DESC` so the freshest activity is first
 * — same view an operator wants when investigating "why didn't this
 * just-placed order show up in ERPNext".
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const q = req.query as {
        status?: string
        event?: string
        limit?: string
        offset?: string
    }
    const limit = Math.max(1, Math.min(500, Number(q.limit ?? 50)))
    const offset = Math.max(0, Number(q.offset ?? 0))

    const filters: Record<string, any> = {}
    if (q.status && ["pending", "success", "failed", "skipped"].includes(q.status)) {
        filters.status = q.status
    }
    if (q.event) {
        filters.event = q.event
    }

    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)

    const [items, count] = await erpnext.listAndCountErpnextSyncEvents(
        filters,
        {
            take: limit,
            skip: offset,
            order: { last_attempt_at: "DESC" },
        },
    )

    res.json({
        items: items.map((r: any) => ({
            id: r.id,
            event: r.event,
            event_id: r.event_id,
            status: r.status,
            attempts: r.attempts,
            last_attempt_at: r.last_attempt_at,
            succeeded_at: r.succeeded_at,
            last_error: r.last_error,
            target_url: r.target_url,
            // payload is intentionally NOT included in the list view —
            // can be large. Fetch a single row to get it (future
            // GET /admin/erpnext/events/:id endpoint).
        })),
        count,
        limit,
        offset,
    })
}
