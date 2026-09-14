import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"

/**
 * GET /store/erpnext/orders/:id/invoices
 *
 * The invoices a signed-in customer can see for one of their orders.
 * An order that is not theirs answers 404, not 403: whether an order id
 * exists is itself something a stranger should not learn.
 */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
    const order = await ownOrder(req)
    if (!order) return res.status(404).json({ message: "Order not found" })
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    res.json({ invoices: await erpnext.invoicesForOrder(order.id) })
}

export async function ownOrder(req: AuthenticatedMedusaRequest): Promise<{ id: string } | null> {
    const customerId = req.auth_context?.actor_id
    if (!customerId) return null
    const orderSvc: any = req.scope.resolve("order")
    const [order] = await orderSvc.listOrders(
        { id: req.params.id, customer_id: customerId },
        { take: 1, select: ["id", "customer_id"] },
    )
    return order ?? null
}
