import { estimateSalesTotals, frappeRound, type SalesEstimate } from "./erpnext-arithmetic"
import { gstStateCodeOf, money, salesLine } from "./push-rest"

/**
 * The store's total, rounded the way ERPNext will round the invoice.
 *
 * ERPNext rounds a sales document's grand total to the rupee and the
 * customer owes the rounded figure. The store charges the same by keeping
 * one cart credit line, reference `erpnext-rounding`, worth the difference
 * between Medusa's total and ERPNext's rounded total (negative when
 * ERPNext rounds up). The figure comes from ERPNext's own arithmetic over
 * the lines the push will send, so it also absorbs a paisa Medusa's own
 * tax sum may differ by.
 */
export const ROUNDING_REFERENCE = "erpnext-rounding"

/** More than this between Medusa's total and ERPNext's means the two
 *  disagree on something real (a rate not synced yet); rounding must not
 *  paper over it. */
const MAX_GAP = 1

export type RoundingPlan =
    | { action: "set"; amount: number; estimate: SalesEstimate; interState: boolean }
    | { action: "clear"; reason: string }
    | { action: "skip"; reason: string }

function sum(rows: any[] | null | undefined, pick: (r: any) => unknown): number {
    return (Array.isArray(rows) ? rows : []).reduce((s, r) => s + money(pick(r)), 0)
}

/**
 * What the rounding line should be for a cart. `companyState` is the
 * seller's two-digit GST state; the supply's state is the billing
 * address's, else the shipping address's, as India Compliance reads it.
 */
export function planCartRounding(args: { cart: any; companyState: string | null; roundTotal: boolean; companyCurrency?: string | null }): RoundingPlan {
    const cart = args.cart ?? {}
    const items: any[] = Array.isArray(cart.items) ? cart.items : []
    if (!args.roundTotal) return { action: "clear", reason: "ERPNext does not round" }
    if (!items.length) return { action: "clear", reason: "empty cart" }
    const currency = String(cart.currency_code ?? "").toLowerCase()
    if (args.companyCurrency && currency !== String(args.companyCurrency).toLowerCase()) {
        return { action: "clear", reason: `cart in ${currency}, company books ${args.companyCurrency}` }
    }
    if (items.some((li) => li?.is_tax_inclusive)) return { action: "skip", reason: "tax-inclusive prices are not estimated" }
    if (!cart.shipping_address) return { action: "clear", reason: "no address yet, so no tax yet" }
    if (items.some((li) => !(Array.isArray(li?.tax_lines) && li.tax_lines.length))) {
        return { action: "clear", reason: "a line has no tax yet" }
    }
    const lines = items.map((li) => {
        const l = salesLine(li)
        return { rate: l.rate, qty: l.qty, gstRate: sum(li.tax_lines, (t) => t?.rate) }
    })
    const shipping = sum(cart.shipping_methods, (m) => m?.amount) - sum(
        (cart.shipping_methods ?? []).flatMap((m: any) => m?.adjustments ?? []),
        (a) => a?.amount,
    )
    const supply =
        gstStateCodeOf(cart.billing_address?.province) ?? gstStateCodeOf(cart.shipping_address?.province) ?? null
    const interState = Boolean(supply && args.companyState && supply !== args.companyState)
    const estimate = estimateSalesTotals({ lines, shipping: frappeRound(shipping, 2), interState, roundTotal: true })
    const ours = sum(
        (cart.credit_lines ?? []).filter((c: any) => c?.reference === ROUNDING_REFERENCE),
        (c) => c?.amount,
    )
    const before = Number(cart.total ?? 0) + ours
    if (Math.abs(before - estimate.grandTotal) > MAX_GAP) {
        return {
            action: "skip",
            reason: `store total ${frappeRound(before, 2)} and ERPNext's ${estimate.grandTotal} differ by more than ${MAX_GAP}`,
        }
    }
    return { action: "set", amount: frappeRound(before - estimate.payable, 2), estimate, interState }
}
