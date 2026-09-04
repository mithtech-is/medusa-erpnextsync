import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/mappings/:mapping_id/dry-run
 *
 * Dry-run a mapping against a real Medusa record without hitting
 * Frappe. Used by the admin "Test" button in the mapping editor.
 *
 * NB the folder is `dry-run`, NOT `test`. Medusa's plugin compiler
 * (.medusa/server compilation) hardcodes `"test"` in
 * `_Compiler_backendIgnoreFiles` so any folder named `test` is
 * silently dropped from the built output. Running `npm run build`
 * succeeds, the source file exists, the TS compiler sees it — but
 * the route file never lands in the runtime tree and every UI click
 * returns 404. Discovered while smoke-testing customer push from
 * /app/erpnext.
 *
 * Body: { record_id?: string }   omit to rehearse against a sample
 *
 * Response (success):
 *   {
 *     ok: true,
 *     payload: { ... Frappe-shaped payload that would be POSTed ... },
 *     key_value: "string",        // the Frappe key derived from the source
 *     skipped_fields: ["..."],    // fields that had no source value
 *   }
 *
 * Response (failure):
 *   { ok: false, message: "<reason>" }
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { mapping_id } = req.params as { mapping_id: string }
    const body = (req.body ?? {}) as { record_id?: string }
    // record_id is optional now. Without one the rehearsal runs against a
    // sample built from the entity's own declared paths, which is what a
    // brand-new mapping needs: there is usually nothing to point at yet,
    // and that is exactly when trying it matters.
    try {
        const result = await erpnext.dryRunPush({
            mapping_id,
            record_id: body.record_id ?? null,
            container: req.scope,
        })
        if (!result.ok) {
            res.status(400).json(result)
            return
        }
        res.json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "dry_run_failed",
        })
    }
}
