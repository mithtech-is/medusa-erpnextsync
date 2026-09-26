import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../modules/erpnext"
import {
    FRAPPE_SIGNATURE_HEADER,
    parseFrappeWebhookBody,
    verifyFrappeSignature,
} from "../../../modules/erpnext/frappe-webhook"

/**
 * POST /webhooks/erpnext-inbound
 *
 * Where the Frappe core Webhooks that "Set up ERPNext" installs deliver.
 * Two per selection DocType, `on_update` and `on_trash`, each carrying
 * `{event, doctype, name, doc}` with the whole document under `doc`.
 *
 * The signature is Frappe's own: base64 HMAC-SHA256 of the request body
 * with the shared secret, in `X-Frappe-Webhook-Signature`. It is checked
 * over the raw bytes, which Medusa keeps only when the request says
 * `Content-Type: application/json` — the Webhook Header row the setup
 * adds. A body that arrives without it gets a 400 that says so.
 *
 * Status codes:
 *   200 — applied, or nothing to do (sync off, no mapping, not selected)
 *   400 — no raw body, or not the body shape above
 *   401 — signature missing or wrong
 *   500 — a write failed; the row is `failed` and the retry job replays it
 *
 * Frappe retries a non-2xx three times (1 s, 4 s). "Skipped" is 200 so
 * that a document that is not ours to touch is not delivered thrice.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)

    const raw: Buffer | undefined = (req as any).rawBody
    if (!raw || !raw.length) {
        res.status(400).json({
            ok: false,
            status: "bad_request",
            message:
                "no raw body: the Frappe Webhook needs a Webhook Header row " +
                "`Content-Type: application/json` (Set up ERPNext adds it)",
        })
        return
    }

    let secret: string | null = null
    try {
        secret = await erpnext.getFrappeWebhookSecret()
    } catch {
        secret = null
    }
    if (!secret) {
        res.status(401).json({
            ok: false,
            status: "unauthorized",
            message: "no Frappe webhook secret is configured on this store",
        })
        return
    }
    if (!verifyFrappeSignature({ rawBody: raw, header: req.headers[FRAPPE_SIGNATURE_HEADER], secret })) {
        res.status(401).json({ ok: false, status: "unauthorized", message: "signature missing or invalid" })
        return
    }

    const parsed = parseFrappeWebhookBody(raw)
    if (parsed.ok === false) {
        res.status(400).json({ ok: false, status: "bad_request", message: parsed.message })
        return
    }

    try {
        const result = await erpnext.receiveFrappeWebhook({ body: parsed.body, scope: req.scope })
        res.status(result.status === "failed" ? 500 : 200).json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            status: "failed",
            message: err?.message ?? "inbound_failed",
        })
    }
}
