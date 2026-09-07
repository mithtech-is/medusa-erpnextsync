import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../modules/erpnext"

/**
 * POST /webhooks/erpnext-describe
 *
 * The read half of the pairing. ERPNext asks what entities this store has
 * and what fields each one carries, so its mapping editor can offer them
 * instead of expecting an operator to remember dot-paths.
 *
 * Signed exactly like an inbound event — HMAC-SHA256 over the raw body in
 * `X-Medusa-Signature` (hex or base64), verified against
 * `frappe_to_medusa_secret`. Nothing here is readable without the secret
 * the two systems already share, so pairing an ERPNext is all it takes and
 * there is no second credential to store or rotate.
 *
 * Body:
 *   {}                    → { entities: [{key, label}, ...] }
 *   { "entity": "order" } → { entity, fields: [...], fields_source }
 *   { "entity": "order", "doctype": "Sales Order" }
 *                         → the same, plus `suggestions`: one suggested
 *                           pair per doctype field the matcher recognised,
 *                           with a confidence so the far side can show
 *                           which to trust.
 *
 * `fields` is the merged discovery result: every column of the module's
 * model, under the curated labels and transforms. `fields_source` says
 * whether that came from the model, a sampled record, or only the curated
 * list — so the far side can tell a short list from a complete one.
 *
 * It lives under /webhooks rather than /admin because the caller is the
 * paired ERPNext holding a shared secret, not a logged-in admin user.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)

    // Same raw-body handling as erpnext-inbound: the HMAC is over the
    // exact bytes, so re-stringifying must match what the sender signed.
    const raw =
        (req as any).rawBody ??
        Buffer.from(JSON.stringify(req.body ?? {}), "utf8")
    const sig =
        (req.headers["x-medusa-signature"] as string | undefined) ??
        (req.headers["x-frappe-webhook-signature"] as string | undefined) ??
        null

    try {
        const result = await erpnext.describeForFrappe({
            rawBody: raw,
            signatureHeader: sig,
            entity: (req.body as any)?.entity ?? null,
            doctype: (req.body as any)?.doctype ?? null,
            scope: req.scope,
        })
        const status =
            result.status === "unauthorized"
                ? 401
                : result.status === "bad_request"
                  ? 400
                  : 200
        res.status(status).json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            status: "failed",
            message: err?.message ?? "describe_failed",
        })
    }
}
