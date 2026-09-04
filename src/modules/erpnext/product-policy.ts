/**
 * What may happen when a product is created in Medusa.
 *
 * ERPNext is the source of truth for the catalogue: products flow ERPNext
 * to Medusa, and a product invented in the storefront must not quietly
 * become a new Item with no cost, no stock and no purchase history behind
 * it. But refusing outright is wrong too — someone adding a product in
 * Medusa usually means "this is the one we already sell", and wants it
 * attached to the Item that exists.
 *
 * So the operator chooses:
 *
 *   off      Medusa-created products never reach ERPNext.
 *   link     they reach ERPNext only once attached to an existing Item.
 *            The default: nothing is invented, and an operator's
 *            deliberate link is honoured.
 *   create   they may create an Item.
 *
 * Updates to a product that is already linked always flow, whatever the
 * policy — the policy governs bringing a NEW product across, not keeping
 * a known one in step.
 */

export type ProductPolicy = "off" | "link" | "create"

export const DEFAULT_PRODUCT_POLICY: ProductPolicy = "link"

export function normalizeProductPolicy(value: unknown): ProductPolicy {
    const v = String(value ?? "").toLowerCase()
    return v === "off" || v === "create" || v === "link" ? v : DEFAULT_PRODUCT_POLICY
}

export type ProductPushDecision = { allow: true } | { allow: false; reason: string }

/**
 * May this product push reach ERPNext?
 *
 * `linked` means the Medusa product already names an ERPNext Item, so
 * there is somewhere for the push to land.
 */
export function decideProductPush(args: {
    policy: unknown
    /** The Medusa event that triggered the push, e.g. "product.created". */
    event: string
    /** Does this product already name an ERPNext Item? */
    linked: boolean
}): ProductPushDecision {
    const policy = normalizeProductPolicy(args.policy)
    if (policy === "off") {
        return { allow: false, reason: "product-policy-off" }
    }
    if (args.linked) {
        // A product we already know: keeping it in step is not "creating".
        return { allow: true }
    }
    if (policy === "create") {
        return { allow: true }
    }
    // policy === "link": an unlinked product has nowhere to land yet.
    return { allow: false, reason: "product-policy-link-required" }
}

/** Where a Medusa product records the ERPNext Item it belongs to. */
export const LINK_KEY = "erpnext_item_code"

export function linkedItemCode(record: any): string | null {
    const code = record?.metadata?.[LINK_KEY]
    return typeof code === "string" && code.trim() ? code.trim() : null
}

export function isLinked(record: any): boolean {
    return linkedItemCode(record) !== null
}
