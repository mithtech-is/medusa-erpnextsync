import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/push/customers
 *
 * Manually push customers to ERPNext, bypassing the live event bus.
 *
 * Body:
 *   - customer_ids?: string[]   — explicit ids; empty/omitted = all
 *                                 customers (use with care — takes O(N))
 *   - limit?: number            — cap when pushing all (default 200, max 1000)
 *   - include_kyc?: boolean     — also pushes a `customer.kyc.synced`
 *                                 event per customer carrying their
 *                                 PAN/Aadhaar verification flags +
 *                                 holder names. PII is never sent in
 *                                 the clear — only the masked / hashed
 *                                 metadata Medusa already stores.
 *
 * Each id triggers a `customer.synced` event on the ERPNext side.
 * Returns per-id outcomes for the admin UI.
 */
const BodySchema = z.object({
    customer_ids: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(1000).optional(),
    include_kyc: z.boolean().optional(),
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
    const { customer_ids, limit, include_kyc } = parsed.data

    const customerModule: any = req.scope.resolve(Modules.CUSTOMER)
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)

    const filter: Record<string, any> = {}
    if (customer_ids && customer_ids.length > 0) {
        filter.id = customer_ids
    }
    const take = customer_ids?.length ? customer_ids.length : (limit ?? 200)
    const rows: any[] = await customerModule
        .listCustomers(filter, {
            take,
            relations: ["addresses"],
        })
        .catch(() => [])

    if (rows.length === 0) {
        res.json({
            ok: true,
            total: 0,
            success: 0,
            failed: 0,
            skipped: 0,
            results: [],
        })
        return
    }

    const customerPush = await erpnext.bulkPush({
        event: "customer.synced",
        items: rows.map((c) => ({ id: c.id, payload: c })),
    })

    let kycPush: any = null
    if (include_kyc) {
        kycPush = await erpnext.bulkPush({
            event: "customer.kyc.synced",
            items: rows.map((c) => ({
                id: c.id,
                payload: buildKycPayload(c),
            })),
        })
    }

    res.json({ ok: true, customers: customerPush, kyc: kycPush })
}

/**
 * Build a KYC-only payload from the customer's metadata. Sends
 * verification flags + the PAN/Aadhaar holder names + the masked /
 * hashed reference fields. Never sends raw PAN or Aadhaar numbers.
 */
function buildKycPayload(c: any) {
    const meta = (c.metadata ?? {}) as Record<string, any>
    return {
        customer_id: c.id,
        email: c.email ?? null,
        phone: c.phone ?? null,
        kyc: {
            pan_verified: meta.pan_verified === true,
            pan_verified_at: meta.pan_verified_at ?? null,
            pan_hash: meta.pan_hash ?? null,
            pan_holder_name: meta.pan_registered_name ?? meta.full_name ?? null,
            aadhaar_verified: meta.aadhaar_verified === true,
            aadhaar_verified_at: meta.aadhaar_verified_at ?? null,
            aadhaar_hash: meta.aadhaar_hash ?? null,
            aadhaar_holder_name:
                meta.aadhaar_registered_name ?? meta.full_name ?? null,
            email_verified: meta.email_verified === true,
            phone_verified: meta.phone_verified === true,
        },
    }
}
