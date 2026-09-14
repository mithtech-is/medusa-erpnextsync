/**
 * The store's own invoice numbers, for stores that number invoices
 * themselves rather than letting ERPNext do it.
 *
 * `prefix` + a zero-padded running number, e.g. WEB-INV-00042. The number
 * is allocated by the caller in a single UPDATE; this only formats it and
 * reads back what an order already holds.
 */

export const DEFAULT_PAD = 5

export function formatInvoiceNumber(prefix: string, n: number, pad = DEFAULT_PAD): string {
    const cleanPrefix = String(prefix ?? "").trim()
    if (!cleanPrefix) throw new Error("the store invoice series has no prefix")
    if (!Number.isInteger(n) || n < 1) throw new Error(`invalid invoice sequence ${n}`)
    return `${cleanPrefix}${String(n).padStart(pad, "0")}`
}

export type InvoiceChoices = {
    invoice_numbering?: string | null
    store_invoice_prefix?: string | null
    send_invoice_to_store?: boolean | null
}

export function storeNumbers(choices: InvoiceChoices | null | undefined): boolean {
    return choices?.invoice_numbering === "store"
}

/** Whether ERPNext will send invoices here for customers to download. */
export function receivesErpInvoices(choices: InvoiceChoices | null | undefined): boolean {
    return !storeNumbers(choices) && Boolean(choices?.send_invoice_to_store)
}
