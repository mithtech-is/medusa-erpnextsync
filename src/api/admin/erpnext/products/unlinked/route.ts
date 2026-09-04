import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * GET /admin/erpnext/products/unlinked
 *
 * Catalogue entries in ERPNext that no Medusa product claims yet — what
 * the operator picks from when attaching a product created here to the
 * one that already exists over there.
 *
 * Query:
 *   - search?: string   substring of the item code
 *   - limit?:  number   default 20, max 200
 *
 * Reads through the Frappe REST proxy, so it needs the API key/secret
 * rather than the webhook secret, and it never writes anything.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const { search, limit } = req.query as { search?: string; limit?: string }

    const result = await erpnext.listUnlinkedCatalogueItems({
        search,
        limit: limit ? Number(limit) : undefined,
    })

    if (!result.ok) {
        // A missing API key is operator configuration, not a server fault:
        // say which doctype was searched so the message is actionable.
        res.status(502).json({
            ok: false,
            doctype: result.doctype,
            message: result.message,
        })
        return
    }
    res.json(result)
}
