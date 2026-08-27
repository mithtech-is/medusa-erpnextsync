import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * GET    /admin/erpnext/mappings/:mapping_id   — single row, full payload
 * POST   /admin/erpnext/mappings/:mapping_id   — update
 * DELETE /admin/erpnext/mappings/:mapping_id   — soft-delete (Medusa default)
 */

export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { mapping_id } = req.params as { mapping_id: string }
    try {
        const row = await erpnext.getMapping(mapping_id)
        if (!row) {
            res.status(404).json({ ok: false, message: "mapping not found" })
            return
        }
        res.json({ mapping: row })
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "mapping_load_failed",
        })
    }
}

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { mapping_id } = req.params as { mapping_id: string }
    const body = (req.body ?? {}) as Record<string, any>
    try {
        const userId = (req as any)?.auth_context?.actor_id ?? null
        const saved = await erpnext.saveMapping({
            ...body,
            id: mapping_id,
            updated_by_user_id: body.updated_by_user_id ?? userId,
        })
        res.json({ ok: true, mapping: saved })
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "mapping_save_failed",
        })
    }
}

export const DELETE = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { mapping_id } = req.params as { mapping_id: string }
    try {
        const result = await erpnext.deleteMapping(mapping_id)
        res.json(result)
    } catch (err: any) {
        res.status(500).json({
            ok: false,
            message: err?.message ?? "mapping_delete_failed",
        })
    }
}
