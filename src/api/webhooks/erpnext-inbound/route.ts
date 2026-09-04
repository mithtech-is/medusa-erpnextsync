import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../modules/erpnext"

/**
 * POST /webhooks/erpnext-inbound
 *
 * F1 — counterpart of the Frappe-side `medusync.api.receive`
 * endpoint. Frappe's standard `Webhook` rows (seeded by F2
 * configured against this URL) POST here.
 *
 * Headers expected:
 *   - x-frappe-webhook-signature   (base64 HMAC-SHA256 of body)
 *     OR
 *     x-medusa-signature           (manual-test alias, hex or base64)
 *   - x-medusa-event-id            (optional — falls back to body.event_id)
 *
 * Body shape (set by the Webhook row's Jinja template):
 *   {
 *     "event":    "wallet.deposit.received" | "customer.updated" | ...,
 *     "event_id": "frappe:<doctype>:<name>:<modified>",
 *     "data":     { ...the doc fields per the Webhook's template }
 *   }
 *
 * HTTP status codes:
 *   200 — handled OR skipped (sync disabled, unknown event)
 *   400 — body not JSON / missing event / missing event_id
 *   401 — signature missing or invalid
 *   500 — handler raised; the row is persisted with status=failed so
 *         the F3 retry cron will pick it up
 *
 * NB Frappe's webhook framework retries on non-2xx for 3 attempts
 * (1s/4s/7s backoff). Returning 200 with status=skipped prevents
 * that wasted noise for events we explicitly don't handle.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)

    // Medusa parses JSON bodies into req.body, but we need the RAW
    // bytes to compute the HMAC (whitespace + key order matter to
    // the signature). req.rawBody is set by the framework when the
    // route has `bodyParser: false` — but we use the default parser
    // and re-stringify, which Frappe's framework matches because it
    // signs over the same JSON.stringify(body) that produced the
    // request body. Pre-stringified bytes from Express are stable.
    const raw =
        (req as any).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}), "utf8")

    const sig =
        (req.headers["x-frappe-webhook-signature"] as string | undefined) ??
        (req.headers["x-medusa-signature"] as string | undefined) ??
        null
    const eventIdHeader =
        (req.headers["x-medusa-event-id"] as string | undefined) ?? null

    try {
        const result = await erpnext.receiveInbound({
            rawBody: raw,
            signatureHeader: sig,
            eventIdHeader,
            // Pass the request scope so handlers can resolve other
            // Medusa modules (customer, product, and the project's own)
            // without the ErpnextModule needing them injected at
            // construction time.
            scope: req.scope,
        })
        const httpStatus =
            result.status === "unauthorized"
                ? 401
                : result.status === "bad_request"
                  ? 400
                  : result.status === "failed"
                    ? 500
                    : 200
        res.status(httpStatus).json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            status: "failed",
            message: err?.message ?? "inbound_failed",
        })
    }
}
