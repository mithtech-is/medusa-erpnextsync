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
 *   - frappe_webhook_secret_masked      — "abc…xyz" preview, never raw
 *   - sync_doctypes / erpnext_setup_*   — the selection DocTypes and the
 *                                         last "Set up ERPNext" report
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
    /** What may happen when a product is created in Medusa. */
    medusa_product_policy: z.enum(["off", "link", "create"]).nullable().optional(),
    erpnext_url: z.string().nullable().optional(),
    /** Where ERPNext POSTs webhooks; absolute http(s). */
    medusa_public_url: z.string().nullable().optional(),
    /** The DocTypes under `medusa_sync` selection, with their modes. */
    sync_doctypes: z
        .array(z.object({ doctype: z.string().min(1), mode: z.enum(["allow", "deny"]).optional() }))
        .nullable()
        .optional(),
    /** The secret every Frappe Webhook signs with; secret semantics. */
    frappe_webhook_secret: z.string().nullable().optional(),
    /** ISO 3166 region for phone numbers without a country code. */
    phone_region: z.string().max(2).nullable().optional(),
    /** Where a pushed document lands; empty falls back to ERPNext's defaults. */
    erpnext_company: z.string().nullable().optional(),
    erpnext_price_list: z.string().nullable().optional(),
    erpnext_customer_group: z.string().nullable().optional(),
    erpnext_territory: z.string().nullable().optional(),
    erpnext_shipping_account: z.string().nullable().optional(),
    erpnext_taxes_template: z.string().nullable().optional(),
    /** Stock and prices, ERPNext → Medusa. */
    sync_stock: z.boolean().optional(),
    sync_prices: z.boolean().optional(),
    erpnext_warehouse: z.string().nullable().optional(),
    medusa_stock_location_id: z.string().nullable().optional(),
    erpnext_safety_stock: z.number().int().min(0).nullable().optional(),
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
    /** Orders and invoices — this store's choice, honoured by the push. */
    order_document: z.string().nullable().optional(),
    invoice_numbering: z.enum(["erpnext", "store"]).nullable().optional(),
    store_invoice_prefix: z.string().nullable().optional(),
    send_invoice_to_store: z.boolean().optional(),
    record_payments: z.boolean().optional(),
    invoice_storage: z.enum(["local", "s3"]).nullable().optional(),
    invoice_local_dir: z.string().nullable().optional(),
    s3_bucket: z.string().nullable().optional(),
    s3_region: z.string().nullable().optional(),
    s3_endpoint: z.string().nullable().optional(),
    s3_prefix: z.string().nullable().optional(),
    s3_force_path_style: z.boolean().optional(),
    s3_access_key_id: z.string().nullable().optional(),
    s3_secret_access_key: z.string().nullable().optional(),
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
        const message = err?.message ?? "settings_save_failed"
        res.status(/must be an absolute/.test(message) ? 400 : 500).json({ message })
    }
}
