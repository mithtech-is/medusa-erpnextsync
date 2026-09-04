import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../modules/erpnext"

/**
 * GET  /admin/erpnext/settings
 * POST /admin/erpnext/settings
 *
 * Backs the admin "ERPNext Sync" settings page.
 *
 * GET response shape (selected fields, see service for full):
 *   - exists                            — whether a DB row exists yet
 *   - enable_sync                       — kill switch
 *   - erpnext_url                       — base URL (or null)
 *   - webhook_secret_masked             — "abc…xyz" preview, never raw
 *   - request_timeout_ms / retry knobs
 *   - env_fallback                      — what env vars currently
 *                                         provide (so the admin UI can
 *                                         show "using env" vs "using
 *                                         saved value")
 *
 * POST contract for secret-typed fields:
 *   - field absent / empty string → leave as-is
 *   - null                        → clear
 *   - other                       → update
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const view = await erpnext.getSettingsView()
        res.json(view)
    } catch (err: any) {
        res.status(500).json({
            message: err?.message ?? "settings_load_failed",
        })
    }
}

const SaveSchema = z.object({
    enable_sync: z.boolean().optional(),
    /** This instance's name on the wire; must match the Medusync Site
     *  record on the ERPNext side. */
    site_id: z.string().nullable().optional(),
    /** Normally set by ERPNext announcing it; here for a manual fix. */
    products_doctype: z.string().nullable().optional(),
    /** What may happen when a product is created in Medusa. */
    medusa_product_policy: z.enum(["off", "link", "create"]).nullable().optional(),
    erpnext_url: z.string().nullable().optional(),
    // Whitelisted Frappe method receiving pushes (e.g. medusync.api.receive).
    frappe_receive_method: z.string().nullable().optional(),
    // Medusa→Frappe HMAC secret (legacy column name `webhook_secret`).
    webhook_secret: z.string().nullable().optional(),
    // Frappe→Medusa HMAC secret (F0 — added for the Webhook seeder).
    frappe_to_medusa_secret: z.string().nullable().optional(),
    erpnext_api_key: z.string().nullable().optional(),
    erpnext_api_secret: z.string().nullable().optional(),
    request_timeout_ms: z.number().int().optional(),
    auto_retry_failed: z.boolean().optional(),
    auto_retry_max_attempts: z.number().int().optional(),
    auto_retry_min_interval_minutes: z.number().int().optional(),
    last_full_resync_at: z.string().nullable().optional(),
    /** Outbound safety valve — newline/comma separated record ids,
     *  emails or handles. Empty = no restriction. */
    push_allowlist: z.string().nullable().optional(),
    /** Days to keep erpnext_sync_event rows. 0 = keep forever. */
    log_retention_days: z.number().int().min(0).max(1825).optional(),
    notes: z.string().nullable().optional(),
})

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const parsed = SaveSchema.safeParse(req.body)
    if (!parsed.success) {
        res.status(400).json({
            message: "Invalid input",
            errors: parsed.error.flatten(),
        })
        return
    }

    const adminUserId =
        (req as any).auth_context?.actor_id ??
        (req as any).auth_context?.app_metadata?.user_id ??
        null

    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    try {
        const view = await erpnext.saveSettings({
            ...parsed.data,
            updated_by_user_id: adminUserId,
        })
        res.json(view)
    } catch (err: any) {
        res.status(500).json({
            message: err?.message ?? "settings_save_failed",
        })
    }
}
