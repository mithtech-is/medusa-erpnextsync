import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { z } from "zod"
import { ERPNEXT_MODULE } from "../../../../../../modules/erpnext"

/**
 * POST /admin/erpnext/products/:id/link   { item_code }
 *
 * Attach a Medusa product to a catalogue entry that already exists in
 * ERPNext, instead of creating a second one.
 *
 * This is the escape hatch the catalogue policy needs. ERPNext owns the
 * catalogue, so a product invented in the storefront does not travel by
 * default; once an operator says which existing Item it is, it does, and
 * lands on that record rather than inventing a new one.
 *
 * Both sides record the link: Medusa keeps the item code, ERPNext gets
 * the Medusa id stamped on the Item, so reconciliation stops reporting
 * the pair as two orphans.
 */
const LinkSchema = z.object({
    item_code: z.string().min(1),
})

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    const parsed = LinkSchema.safeParse(req.body)
    if (!parsed.success) {
        res.status(400).json({
            ok: false,
            message: "item_code is required",
            errors: parsed.error.flatten(),
        })
        return
    }

    const erpnext: any = req.scope.resolve(ERPNEXT_MODULE)
    const result = await erpnext.linkProductToItem({
        product_id: req.params.id,
        item_code: parsed.data.item_code,
        scope: req.scope,
    })

    if (!result.ok) {
        // Everything that can fail here is something the operator can fix:
        // a code that does not exist, one already spoken for, or ERPNext
        // being unreachable. 400 keeps it in the form rather than a toast.
        res.status(400).json(result)
        return
    }
    res.json(result)
}
