import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/orders/:id/request-return
 *
 * The Medusa-initiated return-request last-mile. An admin raises a return
 * for an order; this creates a DRAFT return Delivery Note in ERPNext
 * (zero stock impact) that ops submits on physical receipt — at which
 * point the reverse path fires `order.returned` and restores stock. This
 * is the "receipt gate": requesting a return never moves stock on its own.
 *
 * Body:
 *   - items: [{ sku: string, qty: number, reason?: string }]   (required, non-empty)
 *
 * The ERPNext handler legitimately SKIPS (200, not an error) when the
 * order has no Sales Order yet or nothing has shipped. We surface that
 * reason verbatim in `result` and record the outcome on the order's
 * metadata so the admin sees WHY, instead of a silent success.
 */
const BodySchema = z.object({
    items: z
        .array(
            z.object({
                sku: z.string().min(1),
                qty: z.number().positive(),
                reason: z.string().optional(),
            }),
        )
        .min(1),
})

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const { id } = req.params as { id: string }
    if (!id) {
        res.status(400).json({ ok: false, message: "order id required" })
        return
    }

    const parsed = BodySchema.safeParse(req.body)
    if (!parsed.success) {
        res.status(400).json({
            ok: false,
            message: "Invalid input",
            errors: parsed.error.flatten(),
        })
        return
    }
    const { items } = parsed.data

    const orderModule: any = req.scope.resolve(Modules.ORDER)
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)

    // Confirm the order exists before we reach across to ERPNext, and grab
    // its current metadata so we can merge (not clobber) the request record.
    const [order] = await orderModule
        .listOrders({ id }, { take: 1, select: ["id", "metadata"] })
        .catch(() => [])
    if (!order) {
        res.status(404).json({ ok: false, message: `no order ${id}` })
        return
    }

    // Fire the request across the wire (signed POST → medusync.api.receive →
    // order.return_requested handler → create_pending_return).
    const pushed = await erpnext.requestReturn(id, items)

    // Record the request + its outcome on the order so the storefront/admin
    // can show a pending-return state. Additive merge, like the reverse path.
    const returnDn = pushed?.result?.return_dn ?? null
    const requested_return = {
        items,
        status: pushed?.ok ? pushed.status : "failed",
        return_dn: returnDn,
        reason: pushed?.result?.reason ?? pushed?.error ?? null,
        requested_at: new Date().toISOString(),
    }
    await orderModule
        .updateOrders([
            {
                id,
                metadata: { ...(order.metadata || {}), requested_return },
            },
        ])
        .catch(() => {
            /* metadata is a convenience mirror; the ERPNext DN is the source
             * of truth, so don't fail the request if the mirror write fails. */
        })

    // Pass the ERPNext result through. A skip (e.g. nothing shipped yet) is a
    // 200 with status:"skipped" so the admin UI can render the reason inline.
    if (!pushed?.ok) {
        res.status(pushed?.httpStatus && pushed.httpStatus >= 400 ? pushed.httpStatus : 502).json({
            ok: false,
            order_id: id,
            error: pushed?.error ?? "return request failed",
            result: pushed?.result ?? null,
        })
        return
    }
    res.json({
        ok: true,
        order_id: id,
        status: pushed.status,
        return_dn: returnDn,
        result: pushed.result ?? null,
    })
}
