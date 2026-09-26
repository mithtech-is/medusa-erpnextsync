import { authenticate, defineMiddlewares } from "@medusajs/framework/http"

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
    ],
})
