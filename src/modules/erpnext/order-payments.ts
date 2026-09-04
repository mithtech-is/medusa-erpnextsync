/**
 * Money ERPNext received against an order.
 *
 * A bank transfer, a cheque or a UPI collection never touches Medusa, so
 * the storefront only learns about it from ERPNext. It lands in the
 * order's metadata rather than as a Medusa payment: ERPNext is the
 * accounting authority in this setup, and a Medusa payment record that
 * no captured transaction backs would put a figure in the storefront
 * ledger that nothing reconciles.
 *
 * Receipts accumulate. One order can be settled by three transfers, and
 * an order settled today can be refunded next week, so each receipt is
 * filed under the Payment Entry that produced it rather than replacing a
 * single "payment" object. That also makes a re-send harmless: the same
 * Payment Entry overwrites its own entry and nothing else.
 */

export const PAYMENTS_KEY = "erp_payments"
export const TOTAL_KEY = "erp_payments_total"

export const CANCELLED = "cancelled"

export type Receipt = {
    payment_entry: string
    method: string | null
    reference: string | null
    amount: number
    currency: string | null
    received_at: string | null
    status: string
    against: { doctype: string | null; name: string | null } | null
}

type Metadata = Record<string, any> | null | undefined

/**
 * Read one receipt off the wire. Returns null when the payload cannot be
 * filed — without the Payment Entry name there is nowhere to put it, and
 * a receipt stored under a generated key would duplicate on every retry.
 */
export function receiptFrom(data: any): Receipt | null {
    const paymentEntry = String(data?.payment_entry ?? "").trim()
    if (!paymentEntry) return null
    const amount = Number(data?.amount)
    return {
        payment_entry: paymentEntry,
        method: data?.method ?? null,
        reference: data?.reference ?? null,
        amount: Number.isFinite(amount) ? amount : 0,
        currency: data?.currency ?? null,
        received_at: data?.received_at ?? null,
        status: String(data?.status ?? "received"),
        against: data?.against
            ? {
                  doctype: data.against.doctype ?? null,
                  name: data.against.name ?? null,
              }
            : null,
    }
}

/** Every receipt currently filed against an order. */
export function receiptsOf(metadata: Metadata): Record<string, Receipt> {
    const existing = metadata?.[PAYMENTS_KEY]
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) return {}
    return existing as Record<string, Receipt>
}

/**
 * What the order has actually been paid. A cancelled Payment Entry stays
 * on the record — somebody will ask why the money went away — but it
 * stops counting towards the total.
 */
export function totalReceived(metadata: Metadata): number {
    let total = 0
    for (const receipt of Object.values(receiptsOf(metadata))) {
        if (!receipt || receipt.status === CANCELLED) continue
        const amount = Number(receipt.amount)
        if (Number.isFinite(amount)) total += amount
    }
    // Two decimal places: these are currency amounts, and floating-point
    // addition of 0.1-style figures otherwise leaks a long tail.
    return Math.round(total * 100) / 100
}

/**
 * File one receipt, leaving every other metadata key exactly as it was.
 * Returns a new object; the caller hands it straight to updateOrders.
 */
export function mergeReceipt(metadata: Metadata, receipt: Receipt): Record<string, any> {
    const receipts = {
        ...receiptsOf(metadata),
        [receipt.payment_entry]: receipt,
    }
    const merged = {
        ...(metadata || {}),
        [PAYMENTS_KEY]: receipts,
    }
    merged[TOTAL_KEY] = totalReceived(merged)
    return merged
}
