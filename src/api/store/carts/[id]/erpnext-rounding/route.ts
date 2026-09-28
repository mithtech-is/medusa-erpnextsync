import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ERPNEXT_MODULE } from "../../../../../modules/erpnext"

/**
 * POST /store/carts/:id/erpnext-rounding
 *
 * Brings the cart's rounding line to what makes its total the one ERPNext
 * will invoice (see modules/erpnext/rounding.ts), and its payment
 * collection with it. The storefront calls it before showing the checkout
 * summary and before taking payment. The cart id is the credential, as for
 * every other store cart route.
 */
export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const out = await erpnext.roundCart(req.scope, String(req.params.id))
    res.status(out.ok ? 200 : 404).json({ rounding: out })
}
