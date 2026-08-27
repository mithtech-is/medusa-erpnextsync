import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * GET /admin/erpnext/mappings/autofill?entity=customer&doctype=Sales%20Invoice
 *
 * Build a complete draft field-map for ANY (entity, doctype) pair by
 * reading the doctype's live field meta and matching it against the
 * entity's registered dot-paths.
 *
 * This is the generic sibling of `mappings/suggest`, which only answers
 * for the six canonical pairs hard-coded in canonical-mappings.ts. The
 * admin editor calls THIS on every doctype change; `suggest` remains
 * for the "give me exactly the shipped canonical set" button.
 *
 * Query:
 *   entity     — Medusa entity key from /admin/erpnext/medusa-entities
 *   doctype    — Frappe doctype name
 *   direction  — push | pull | both   (default: canonical's, else both)
 *   mode       — smart | all | matched
 *                  smart   (default) mandatory fields + everything matched
 *                  all               every writable field on the doctype
 *                  matched           only fields we found a source for
 *
 * Response adds `annotations` (per-row confidence + reason, parallel to
 * the emitted pairs plus the mandatory-but-unmatched ones) so the UI can
 * badge each row. Annotations are display-only and never persisted.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const q = req.query as Record<string, any>
    const entity = String(q.entity ?? "").trim()
    const doctype = String(q.doctype ?? "").trim()
    if (!entity || !doctype) {
        res.status(400).json({
            ok: false,
            message: "entity and doctype query params are required",
        })
        return
    }

    const direction = ["push", "pull", "both"].includes(String(q.direction))
        ? (String(q.direction) as "push" | "pull" | "both")
        : undefined
    const mode = ["smart", "all", "matched"].includes(String(q.mode))
        ? (String(q.mode) as "smart" | "all" | "matched")
        : undefined

    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const result = await erpnext.autofillMapping({
            entity,
            doctype,
            direction,
            mode,
            container: req.scope,
        })
        // A failed autofill is almost always "Frappe isn't reachable /
        // the api_key can't read DocType" — surface it as 502 so the UI
        // can point at Settings rather than showing an empty grid.
        res.status(result.ok ? 200 : 502).json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "autofill_failed",
        })
    }
}
