import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"
import { parseFrappeWebhookBody } from "../../../../../modules/erpnext/frappe-webhook"

/**
 * POST /admin/erpnext/studio/plan-inbound
 *
 * What would happen if this arrived from ERPNext? Reports which enabled
 * mapping would take it, the entity and key it would land on, the payload
 * it would write, and the fields the mapping dropped because the source
 * had no value for them. Reads; writes nothing.
 *
 * It asks the same code the real inbound path asks, so a wrong field name
 * shows up here rather than as a wrong record. A rehearsal that reasons
 * independently is worse than none, because it is believed.
 *
 * Body: what a Frappe Webhook sends —
 *   { event: "on_update" | "on_trash", doctype, name, doc: {...} }
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const parsed = parseFrappeWebhookBody(req.body ?? {})
    if (parsed.ok === false) {
        res.status(400).json({ ok: false, message: parsed.message })
        return
    }
    try {
        const plan = await erpnext.planInbound(parsed.body)
        res.json({ ok: true, event: parsed.body.event, ...plan })
    } catch (err: any) {
        res.status(500).json({ ok: false, message: err?.message ?? "plan_failed" })
    }
}
