/**
 * ERPNext Delivery Notes → Medusa fulfilments.
 *
 * Goods leave through ERPNext: staff submit a store order's Sales Order
 * and make a Delivery Note from it. The note's Stock Ledger Entries reach
 * the plugin through the stock webhook it already has, and the plugin
 * marks the same lines fulfilled and shipped in Medusa, so nobody enters
 * the shipment twice.
 *
 * Everything here is pure; the service does the reading and writing.
 */

export const DELIVERY_NOTE_DOCTYPE = "Delivery Note"

/** A Stock Ledger Entry that belongs to a Delivery Note: its name, and whether it reverses one. */
export function deliveryNoteOf(sle: any): { name: string; cancelled: boolean } | null {
    if (String(sle?.voucher_type ?? "") !== DELIVERY_NOTE_DOCTYPE || !sle?.voucher_no) return null
    return { name: String(sle.voucher_no), cancelled: Number(sle?.is_cancelled) === 1 }
}

export type OrderLineForDelivery = {
    id: string
    /** The ERPNext Item code the line was pushed as. */
    code: string | null
    quantity: number
    /** Already fulfilled in Medusa. */
    fulfilled: number
}

/**
 * Which order lines one Sales Order's part of a Delivery Note covers.
 * Each DN row goes to the order's lines of the same Item, in order, up to
 * what each line still has to fulfil. Quantity the order cannot take is
 * reported, never forced.
 */
export function planDeliveryFulfilment(args: {
    dnItems: Array<{ item_code?: string | null; qty?: number | string | null; against_sales_order?: string | null }>
    salesOrder: string
    lines: OrderLineForDelivery[]
}): { items: Array<{ id: string; quantity: number }>; unmatched: string[] } {
    const open = new Map<string, number>()
    for (const l of args.lines) open.set(l.id, Math.max(0, (Number(l.quantity) || 0) - (Number(l.fulfilled) || 0)))
    const take = new Map<string, number>()
    const unmatched: string[] = []
    for (const row of args.dnItems ?? []) {
        if (String(row?.against_sales_order ?? "") !== args.salesOrder) continue
        const code = String(row?.item_code ?? "")
        let qty = Number(row?.qty) || 0
        for (const l of args.lines) {
            if (qty <= 0) break
            if (l.code !== code) continue
            const room = open.get(l.id) ?? 0
            if (room <= 0) continue
            const n = Math.min(room, qty)
            open.set(l.id, room - n)
            take.set(l.id, (take.get(l.id) ?? 0) + n)
            qty -= n
        }
        if (qty > 0) unmatched.push(`${code} × ${qty}`)
    }
    return { items: Array.from(take, ([id, quantity]) => ({ id, quantity })), unmatched }
}

/** The Sales Orders a Delivery Note draws on, in first-seen order. */
export function salesOrdersOf(dnItems: Array<{ against_sales_order?: string | null }> | null | undefined): string[] {
    const out: string[] = []
    for (const r of dnItems ?? []) {
        const so = String(r?.against_sales_order ?? "")
        if (so && !out.includes(so)) out.push(so)
    }
    return out
}
