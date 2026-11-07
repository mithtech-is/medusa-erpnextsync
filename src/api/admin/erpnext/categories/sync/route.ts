import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/categories/sync
 *
 * Bring the category tree in step with ERPNext's Item Groups now, or with
 * `dry_run` report what that would change and write nothing.
 */
const Body = z.object({ dry_run: z.boolean().optional() })

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const parsed = Body.safeParse(req.body ?? {})
    if (!parsed.success) {
        return res.status(400).json({ ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") })
    }
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const out = await erpnext.syncCategories(req.scope, { dryRun: Boolean(parsed.data.dry_run) })
        if ("skipped" in out) return res.json({ ok: true, skipped: out.skipped })
        return res.json({ ok: true, report: out })
    } catch (err: any) {
        return res.status(502).json({ ok: false, message: err?.message ?? "category_sync_failed" })
    }
}
