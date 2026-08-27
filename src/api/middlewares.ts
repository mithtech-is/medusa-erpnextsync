import { defineMiddlewares } from "@medusajs/framework/http"

/**
 * Plugin-local middlewares.
 *
 * Webhook HMAC verification on /webhooks/erpnext-inbound requires the
 * exact bytes Frappe POSTed — JSON re-serialization after the default
 * body parser breaks the digest. The medusa-backend's own
 * middlewares.ts has a `/webhooks/*` rule with preserveRawBody, but it
 * doesn't reach plugin-registered routes consistently (depending on
 * the order plugins vs app middlewares are mounted). This local copy
 * makes the contract explicit: any POST under the plugin's
 * `/webhooks/*` namespace gets `req.rawBody` populated alongside the
 * parsed `req.body`. The receiver in modules/erpnext/index.ts then
 * computes HMAC over `req.rawBody` so it matches Frappe's signing
 * bytes byte-for-byte.
 */
export default defineMiddlewares({
    routes: [
        {
            matcher: "/webhooks/*",
            method: ["POST"],
            bodyParser: { preserveRawBody: true },
        },
    ],
})
