import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/push/orders
 *
 * Manually push orders to ERPNext (event: `order.synced`).
 *
 * Body:
 *   - order_ids?: string[]   — explicit ids; empty/omitted = all
 *   - limit?: number         — cap (default 200, max 1000)
 */
const BodySchema = z.object({
    order_ids: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(1000).optional(),
})

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const parsed = BodySchema.safeParse(req.body)
    if (!parsed.success) {
        res.status(400).json({
            ok: false,
            message: "Invalid input",
            errors: parsed.error.flatten(),
        })
        return
    }
    const { order_ids, limit } = parsed.data

    const orderModule: any = req.scope.resolve(Modules.ORDER)
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)

    const filter: Record<string, any> = {}
    if (order_ids && order_ids.length > 0) {
        filter.id = order_ids
    }
    const take = order_ids?.length ? order_ids.length : (limit ?? 200)

    const rows: any[] = await orderModule
        .listOrders(filter, {
            take,
            relations: [
                "items",
                "items.variant",
                "items.variant.product",
                "shipping_address",
                "billing_address",
                "payment_collections",
            ],
        })
        .catch(() => [])

    if (rows.length === 0) {
        res.json({
            ok: true,
            total: 0,
            success: 0,
            failed: 0,
            skipped: 0,
            results: [],
        })
        return
    }

    const result = await erpnext.bulkPush({
        event: "order.synced",
        items: rows.map((o) => ({ id: o.id, payload: o })),
    })

    res.json({ ok: true, ...result })
}
