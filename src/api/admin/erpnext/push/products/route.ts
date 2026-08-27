import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/push/products
 *
 * Manually push Medusa Products to ERPNext (event: `product.synced`).
 * The Frappe-side maps Product → Item using ISIN as the unique
 * identifier (each product carries its ISIN in metadata + variant
 * options; see workflows/hooks/validate-product-isin.ts).
 *
 * Body:
 *   - product_ids?: string[]
 *   - limit?: number  (default 200, max 1000)
 */
const BodySchema = z.object({
    product_ids: z.array(z.string()).optional(),
    limit: z.number().int().positive().max(1000).optional(),
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
    const { product_ids, limit } = parsed.data

    const productModule: any = req.scope.resolve(Modules.PRODUCT)
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)

    const filter: Record<string, any> = {}
    if (product_ids && product_ids.length > 0) {
        filter.id = product_ids
    }
    const take = product_ids?.length ? product_ids.length : (limit ?? 200)

    const rows: any[] = await productModule
        .listProducts(filter, {
            take,
            relations: ["variants", "variants.options", "options", "tags"],
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

    const result = await erpnext.bulkPush({
        event: "product.synced",
        items: rows.map((p) => ({ id: p.id, payload: p })),
    })

    res.json({ ok: true, ...result })
}
