import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../../../modules/erpnext"
import { ownOrder } from "../route"

/**
 * GET /store/erpnext/orders/:id/invoices/:invoice_id
 *
 * Streams the invoice PDF to the customer who owns the order, and to
 * nobody else. There is no shareable link: every download re-checks the
 * session, so a forwarded URL is useless without the customer's login.
 */
export const GET = async (req: AuthenticatedMedusaRequest, res: MedusaResponse) => {
    const order = await ownOrder(req)
    if (!order) return res.status(404).json({ message: "Order not found" })
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    // Opening the file can throw on the store's own misconfiguration — S3
    // credentials cleared after an invoice was stored, say. That is not the
    // customer's business and the message would describe our setup, so it
    // reads as an absent file here and is logged for the operator.
    let opened: any = null
    try {
        opened = await erpnext.openInvoice(req.params.invoice_id)
    } catch (e) {
        req.scope.resolve("logger").error(`erpnext: cannot open invoice ${req.params.invoice_id}: ${e}`)
    }
    if (!opened || opened.invoice.order_id !== order.id) {
        return res.status(404).json({ message: "Invoice not available" })
    }
    const filename = `${String(opened.invoice.number).replace(/[^A-Za-z0-9._-]+/g, "_")}.pdf`
    res.setHeader("Content-Type", opened.object.contentType)
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`)
    res.setHeader("Cache-Control", "private, no-store")
    if (opened.object.size != null) res.setHeader("Content-Length", String(opened.object.size))
    opened.object.body.on("error", () => res.destroy())
    opened.object.body.pipe(res)
}
