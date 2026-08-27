import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/pull/items
 *
 * Pull a page of Items from ERPNext using Frappe's REST resource API.
 * This endpoint READS the remote list — it does NOT write to Medusa
 * yet. Treat the response as a preview / connectivity check; the
 * write-back-to-Medusa step is intentionally separate (operator must
 * decide what fields map to Product / variants / options for their
 * specific Frappe customisations).
 *
 * Body:
 *   - limit?: number          — default 50, max 500
 *   - filters?: any           — Frappe filter spec passed through
 *   - fields?: string[]       — Frappe fields list passed through
 *   - doctype?: string        — default "Item"; allow override for
 *                               Sales Invoice / Customer pulls in the
 *                               same shape.
 */
const BodySchema = z.object({
    limit: z.number().int().positive().max(500).optional(),
    filters: z.any().optional(),
    fields: z.array(z.string()).optional(),
    doctype: z.string().min(1).max(100).optional(),
})

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const parsed = BodySchema.safeParse(req.body)
    if (!parsed.success) {
        res.status(400).json({
            ok: false,
            message: "Invalid input",
            errors: parsed.error.flatten(),
        })
        return
    }
    const { limit, filters, fields, doctype } = parsed.data

    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const result = await erpnext.pullDoctype(doctype ?? "Item", {
            limit,
            filters,
            fields,
        })
        res.json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "pull_failed",
        })
    }
}
