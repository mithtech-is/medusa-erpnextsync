import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * POST /admin/erpnext/seed-frappe-webhooks
 *
 * Creates (or upserts) the standard Frappe `Webhook` rows on the
 * connected Frappe site so doc-events on the Frappe side fire
 * HMAC-signed POSTs into Medusa's /webhooks/erpnext-inbound route.
 *
 * Body (optional):
 *   { medusa_base_url: "https://medusa.example.com" }
 *   — sets the request_url base on each created Webhook row. Falls
 *     back to env MEDUSA_BASE_URL, then errors if neither set.
 *
 * Returns:
 *   { seeded: string[], skipped: string[], errors: [...] }
 *
 * Idempotent. Wired to the "Reseed Frappe webhooks" admin button.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const medusaBaseUrl =
        typeof (req.body as any)?.medusa_base_url === "string"
            ? ((req.body as any).medusa_base_url as string)
            : undefined
    try {
        const result = await erpnext.seedFrappeWebhooks({ medusaBaseUrl })
        res.json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "seed_frappe_webhooks_failed",
        })
    }
}
