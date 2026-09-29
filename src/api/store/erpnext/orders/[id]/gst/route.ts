import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"
import { ownOrder } from "../invoices/route"

/**
 * GET /store/erpnext/orders/:id/gst
 *
 * The GST on a signed-in customer's order as ERPNext computed it: the
 * Sales Invoice when there is one, else the Sales Order. The storefront's
 * proforma quotes these rows instead of working tax out itself.
 */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
    const order = await ownOrder(req)
    if (!order) return res.status(404).json({ message: "Order not found" })
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    res.json({ gst: await erpnext.gstForOrder(order.id) })
}
