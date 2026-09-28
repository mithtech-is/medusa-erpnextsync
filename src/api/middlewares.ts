import { authenticate, defineMiddlewares } from "@medusajs/framework/http"
import type { MedusaNextFunction, MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../modules/erpnext"

/**
 * After a saved address is deleted, retire its ERPNext Address and push the
 * customer. The delete workflow hard-deletes the address before its hook
 * runs, so the customer is taken from the request here instead.
 */
function afterAddressDelete(customerOf: (req: MedusaRequest) => string | undefined) {
    return (req: MedusaRequest, res: MedusaResponse, next: MedusaNextFunction) => {
        res.on("finish", () => {
            // Read at the end: the route's own authentication may run after this.
            const customerId = customerOf(req)
            const addressId = (req.params as any)?.address_id
            if (res.statusCode >= 300 || !customerId || !addressId) return
            const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
            void erpnext.addressRemoved(req.scope, String(customerId), String(addressId)).catch((err: any) => {
                console.warn("[erpnext] deleted address not retired:", err?.message ?? err)
            })
        })
        next()
    }
}

/**
 * Plugin-local middlewares.
 *
 * A Frappe core Webhook signs the exact bytes it sends, so the inbound
 * route verifies over `req.rawBody`, never over a re-serialised
 * `req.body`. Medusa keeps the raw body only for requests its JSON,
 * text or form parser handled — and only when asked, so it is asked here
 * for every POST under `/webhooks/*`. (Frappe sends no Content-Type of
 * its own; the header row "Set up ERPNext" adds is what makes the parser
 * run.) An Item with its child tables can be tens of kilobytes, hence the
 * limit.
 */
export default defineMiddlewares({
    routes: [
        {
            matcher: "/webhooks/*",
            method: ["POST"],
            bodyParser: { preserveRawBody: true, sizeLimit: "2mb" },
        },
        {
            // A customer's invoices are theirs alone; no guest access.
            matcher: "/store/erpnext/*",
            middlewares: [authenticate("customer", ["session", "bearer"])],
        },
        {
            matcher: "/store/customers/me/addresses/:address_id",
            method: ["DELETE"],
            middlewares: [afterAddressDelete((req: any) => req.auth_context?.actor_id)],
        },
        {
            matcher: "/admin/customers/:id/addresses/:address_id",
            method: ["DELETE"],
            middlewares: [afterAddressDelete((req: any) => req.params?.id)],
        },
    ],
})
