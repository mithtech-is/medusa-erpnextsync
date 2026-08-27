import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * POST /admin/erpnext/seed-mappings
 *
 * Idempotent — looks up each canonical mapping by `name`, skips
 * ones that already exist, creates the rest. Returns the lists
 * for the admin UI to surface (so the operator sees exactly
 * what changed).
 *
 * Wired to the "Reseed canonical mappings" button on the Settings
 * tab (F4). Also called once at plugin migration time so first-
 * install deployments have a usable starter set.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const result = await erpnext.seedCanonicalMappings()
        res.json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "seed_failed",
        })
    }
}
