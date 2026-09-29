/**
 * ERPNext issues a store order's invoice; the customer downloads ERPNext's
 * own PDF of it.
 *
 * A Sales Invoice's `on_submit` / `on_cancel` webhook tells the store the
 * invoice was issued or withdrawn. Only a submitted invoice is the
 * customer's document: a draft can still change, so its PDF is never
 * fetched, and a cancelled one is kept on record but not offered.
 */

export const SALES_INVOICE_DOCTYPE = "Sales Invoice"

export type InvoiceStatus = "draft" | "submitted" | "cancelled"

/** What a Sales Invoice event, or a document's docstatus, means for the customer's copy. */
export function invoiceStatusOf(event: string | null | undefined, docstatus?: unknown): InvoiceStatus {
    if (event === "on_cancel" || Number(docstatus) === 2) return "cancelled"
    if (event === "on_submit" || Number(docstatus) === 1) return "submitted"
    return "draft"
}

/** Only an issued invoice is offered to the customer. */
export function isDownloadable(row: { status?: string | null; object_key?: string | null }): boolean {
    return row.status === "submitted" && Boolean(row.object_key)
}

/** The Sales Orders an invoice bills, in first-seen order. */
export function salesOrdersBilled(items: Array<{ sales_order?: string | null }> | null | undefined): string[] {
    const out: string[] = []
    for (const it of items ?? []) {
        const so = String(it?.sales_order ?? "")
        if (so && !out.includes(so)) out.push(so)
    }
    return out
}

/**
 * The amount the customer owes on the invoice: the rounded total, unless
 * the document switches rounding off (ERPNext then leaves it at 0).
 */
export function invoiceTotalOf(doc: any): number | null {
    const rounded = Number(doc?.rounded_total)
    if (!Number(doc?.disable_rounded_total) && Number.isFinite(rounded) && rounded > 0) return rounded
    const grand = Number(doc?.grand_total)
    return Number.isFinite(grand) ? grand : null
}
