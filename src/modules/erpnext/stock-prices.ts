/**
 * Stock and prices, ERPNext → Medusa (Phase 3). ERPNext owns both.
 *
 * Stock: what a store may sell at its warehouse is what is on hand less
 * what Sales Orders already promise less a safety buffer, never negative
 * — the rule the old app applied. It moves on a Stock Ledger Entry (a
 * receipt or an issue) and on a Sales Order submit or cancel (reserved
 * quantity moves with no ledger entry). The level is read from the Bin
 * afterwards, not from the event, because neither is final at the event.
 *
 * Prices: an Item Price on the store's selling price list is the
 * variant's price in that currency. Quantity tiers, customer-specific
 * prices and prices not valid today are left alone; Medusa never writes a
 * price back.
 *
 * Everything here is pure; the service does the reading and writing.
 */

import { allowsPull, parseRecordDirection } from "./selection"

export const STOCK_LEDGER_DOCTYPE = "Stock Ledger Entry"
export const SALES_ORDER_DOCTYPE = "Sales Order"
export const ITEM_PRICE_DOCTYPE = "Item Price"
export const STOCK_DOCTYPES = new Set([STOCK_LEDGER_DOCTYPE, SALES_ORDER_DOCTYPE])

export function isStockOrPriceDoctype(doctype: string | null | undefined): boolean {
    const dt = String(doctype ?? "")
    return STOCK_DOCTYPES.has(dt) || dt === ITEM_PRICE_DOCTYPE
}

function num(v: unknown): number {
    const n = typeof v === "number" ? v : Number(v)
    return Number.isFinite(n) ? n : 0
}

/** On hand, less what is promised, less the buffer; never negative. */
export function sellableQty(bin: { actual_qty?: unknown; reserved_qty?: unknown } | null | undefined, safety: unknown): number {
    const available = num(bin?.actual_qty) - num(bin?.reserved_qty) - Math.max(0, num(safety))
    return Math.max(0, available)
}

/** The Item's own buffer when it has one, else the store's. */
export function safetyFor(itemSafety: unknown, storeSafety: unknown): number {
    const item = num(itemSafety)
    return item > 0 ? item : Math.max(0, num(storeSafety))
}

export type StockPair = { item_code: string; warehouse: string }

/** The (item, warehouse) pairs an event moved at the store's warehouse. */
export function stockPairsOf(body: { doctype?: string | null; doc?: any }, warehouse: string | null | undefined): StockPair[] {
    const wh = String(warehouse ?? "").trim()
    if (!wh) return []
    const doc = body?.doc ?? {}
    if (body.doctype === STOCK_LEDGER_DOCTYPE) {
        if (doc.item_code && String(doc.warehouse ?? "") === wh) return [{ item_code: String(doc.item_code), warehouse: wh }]
        return []
    }
    if (body.doctype === SALES_ORDER_DOCTYPE) {
        const seen = new Set<string>()
        const out: StockPair[] = []
        for (const line of Array.isArray(doc.items) ? doc.items : []) {
            const code = line?.item_code ? String(line.item_code) : ""
            if (!code || String(line?.warehouse ?? "") !== wh || seen.has(code)) continue
            seen.add(code)
            out.push({ item_code: code, warehouse: wh })
        }
        return out
    }
    return []
}

export type PricePlan =
    | { action: "set"; item_code: string; currency: string; amount: number }
    | { action: "remove"; item_code: string; currency: string }
    | { action: "skip"; reason: string }

/** What one Item Price event means for the store. `today` is the site's date, YYYY-MM-DD. */
export function planItemPrice(args: { event: string; doc: any; priceList: string | null | undefined; today: string }): PricePlan {
    const doc = args.doc ?? {}
    const list = String(args.priceList ?? "").trim()
    if (!list) return { action: "skip", reason: "no selling price list configured" }
    if (String(doc.price_list ?? "") !== list) return { action: "skip", reason: `not the store's price list (${doc.price_list ?? "blank"})` }
    const item_code = doc.item_code ? String(doc.item_code) : ""
    if (!item_code) return { action: "skip", reason: "no item code on the price" }
    const currency = String(doc.currency ?? "").trim().toLowerCase()
    if (!currency) return { action: "skip", reason: "no currency on the price" }
    if (doc.customer) return { action: "skip", reason: "a customer-specific price" }
    if (num(doc.packing_unit) > 1) return { action: "skip", reason: `a quantity tier (packing unit ${doc.packing_unit})` }
    if (doc.selling !== undefined && doc.selling !== null && !num(doc.selling)) return { action: "skip", reason: "not a selling price" }
    if (args.event === "on_trash") return { action: "remove", item_code, currency }
    const from = String(doc.valid_from ?? "").slice(0, 10)
    const upto = String(doc.valid_upto ?? "").slice(0, 10)
    if (upto && upto < args.today) return { action: "skip", reason: `expired on ${upto}` }
    if (from && from > args.today) return { action: "skip", reason: `valid from ${from}` }
    const amount = Number(doc.price_list_rate)
    if (!Number.isFinite(amount) || amount < 0) return { action: "skip", reason: "no usable rate" }
    return { action: "set", item_code, currency, amount }
}

/** A Python string literal for a Webhook condition. */
function py(s: string): string {
    return JSON.stringify(String(s))
}

/** Fires for a ledger entry at the store's warehouse only. A Webhook
 *  condition sees `doc` alone (no frappe.db), so the selection field of
 *  the Item is checked here, on arrival, not there. */
export function stockLedgerCondition(warehouse: string): string {
    return `doc.warehouse == ${py(warehouse)}`
}

/** Fires for a selling price on the store's list. */
export function itemPriceCondition(priceList: string): string {
    return `doc.price_list == ${py(priceList)} and doc.selling == 1`
}

/**
 * Only an Item that moves ERPNext → Medusa (or both ways) moves its stock
 * and price. A link ERPNext has never shown a direction for — a product
 * linked by hand — is allowed, like a push is.
 */
export function stockAllowedByLink(link: { remote_direction?: string | null } | null | undefined): boolean {
    if (!link || link.remote_direction === null || link.remote_direction === undefined) return true
    return allowsPull(parseRecordDirection(link.remote_direction))
}
