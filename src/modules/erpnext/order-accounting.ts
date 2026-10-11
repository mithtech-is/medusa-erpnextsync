/**
 * What ERPNext's books should say about a store order, decided from the
 * order as Medusa has it now rather than from the event that brought it.
 *
 * With "Record payments" on:
 *   - an order paid online, once captured in full, gets its Sales Order
 *     and Sales Invoice submitted and one submitted Payment Entry per
 *     captured payment, booked to the Mode of Payment mapped for the
 *     payment's provider;
 *   - a cash-on-delivery order gets its Sales Order submitted when it is
 *     placed. Its invoice stays a draft and no Payment Entry is made: the
 *     cash is recorded in ERPNext when it arrives.
 * Deciding from state means a replayed or late event lands on the same
 * documents instead of making new ones.
 */

export const PAYMENT_ENTRY_DOCTYPE = "Payment Entry"
/** The link table's entity for a Medusa payment booked as a Payment Entry. */
export const PAYMENT_ENTITY = "payment"

/** A captured payment's refund, announced on the order it belongs to. */
export const ORDER_REFUNDED_EVENT = "order.payment_refunded"
export const ORDER_CANCELED_EVENT = "order.canceled"

/** Medusa payment provider id → ERPNext Mode of Payment, when Settings has none. */
export const DEFAULT_PAYMENT_MODES: Readonly<Record<string, string>> = Object.freeze({
    "pp_cashfree-pg": "Cashfree",
})

/** A captured payment as the order record carries it (registry.ts). */
export type CapturedPayment = {
    id: string
    amount: number
    currency?: string | null
    provider_id?: string | null
    captured_at?: string | null
    reference?: string | null
    refunded?: number | null
}

export type AccountingPlan =
    | { action: "none"; reason: string }
    | { action: "submit-order"; reason: string }
    | { action: "record-payments"; payments: Array<CapturedPayment & { mode: string }> }
    | { action: "fail"; error: string }

/** The provider → Mode of Payment map Settings holds; null means the default. */
export function normalizePaymentModes(raw: unknown): Record<string, string> {
    let value = raw
    if (value === null || value === undefined) return { ...DEFAULT_PAYMENT_MODES }
    if (typeof value === "string") {
        try {
            value = JSON.parse(value)
        } catch {
            return {}
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const out: Record<string, string> = {}
    for (const [provider, mode] of Object.entries(value as Record<string, unknown>)) {
        const p = String(provider ?? "").trim()
        const m = typeof mode === "string" ? mode.trim() : ""
        if (p && m) out[p] = m
    }
    return out
}

/** Medusa names a provider `pp_<identifier>_<id>`; the store's COD provider is `pp_cod`. */
export function isCashOnDelivery(providerId: string | null | undefined): boolean {
    return /^pp_cod(_|$)/.test(String(providerId ?? ""))
}

/**
 * The gateway's own id for a payment, which is what a bank statement and
 * the gateway's settlement report name. Null when the provider kept none.
 */
export function transactionReference(data: unknown): string | null {
    if (!data || typeof data !== "object") return null
    const d = data as Record<string, unknown>
    for (const key of ["cf_payment_id", "transaction_id", "payment_id"]) {
        const v = d[key]
        if ((typeof v === "string" && v.trim()) || (typeof v === "number" && Number.isFinite(v))) return String(v).trim()
    }
    return null
}

/** Every provider an order was paid, or is to be paid, through. */
export function providersOf(order: any): string[] {
    const out: string[] = []
    const add = (p: unknown) => {
        const v = String(p ?? "").trim()
        if (v && !out.includes(v)) out.push(v)
    }
    for (const p of Array.isArray(order?.payment_providers) ? order.payment_providers : []) add(p)
    for (const p of Array.isArray(order?.payments) ? order.payments : []) add(p?.provider_id)
    return out
}

export function planOrderAccounting(args: {
    recordPayments: boolean
    order: any
    /** Paid in full, as the push decides it (push-rest.ts `orderFullyPaid`). */
    fullyPaid: boolean
    modes: Record<string, string>
}): AccountingPlan {
    if (!args.recordPayments) return { action: "none", reason: "payments are not recorded (Settings)" }
    if (providersOf(args.order).some(isCashOnDelivery)) {
        return { action: "submit-order", reason: "cash on delivery: the cash is recorded in ERPNext" }
    }
    const captured: CapturedPayment[] = (Array.isArray(args.order?.payments) ? args.order.payments : []).filter(
        (p: any) => p?.id && Number(p?.amount) > 0,
    )
    if (!captured.length || !args.fullyPaid) return { action: "none", reason: "not paid in full yet" }
    const unmapped = captured.filter((p) => !args.modes[String(p.provider_id ?? "")])
    if (unmapped.length) {
        const ids = [...new Set(unmapped.map((p) => String(p.provider_id ?? "unknown")))].join(", ")
        return {
            action: "fail",
            error: `no Mode of Payment for payment provider ${ids}; map it under Settings → Payments into ERPNext`,
        }
    }
    return {
        action: "record-payments",
        payments: captured.map((p) => ({ ...p, mode: args.modes[String(p.provider_id)] })),
    }
}

/**
 * How much of an invoice one captured payment settles. Within a paisa of
 * what is outstanding, ERPNext's own figure is used, so its rounding
 * leaves nothing outstanding; less is booked as a part payment; more is
 * refused rather than guessed at.
 */
export function paymentAmount(
    captured: number,
    outstanding: number,
):
    | { ok: true; partyAmount: number | null; note?: string }
    | { ok: true; skip: string }
    | { ok: false; error: string } {
    const c = Math.round(Number(captured) * 100) / 100
    const o = Math.round(Number(outstanding) * 100) / 100
    if (!Number.isFinite(c) || c <= 0) return { ok: false, error: "the payment has no captured amount" }
    if (!Number.isFinite(o) || o <= 0) return { ok: true, skip: "the invoice has nothing outstanding" }
    if (Math.abs(c - o) <= 0.01) return { ok: true, partyAmount: null }
    if (c < o) return { ok: true, partyAmount: c, note: `part payment: ${(o - c).toFixed(2)} still outstanding` }
    return { ok: false, error: `captured ${c.toFixed(2)} is more than the invoice's outstanding ${o.toFixed(2)}` }
}

/**
 * ERPNext's Payment Entry (from `get_payment_entry`) with the store's
 * facts on it, ready to insert as a draft.
 */
export function preparePaymentEntry(
    pe: Record<string, any>,
    facts: { mode: string; reference: string; referenceDate: string },
): Record<string, any> {
    const doc: Record<string, any> = { ...pe }
    for (const k of ["name", "__islocal", "__unsaved", "docstatus", "creation", "modified", "owner", "modified_by"]) delete doc[k]
    doc.references = (Array.isArray(pe.references) ? pe.references : []).map((r: any) => {
        const row = { ...r }
        for (const k of ["name", "__islocal", "__unsaved", "parent", "docstatus"]) delete row[k]
        return row
    })
    doc.mode_of_payment = facts.mode
    doc.reference_no = facts.reference
    doc.reference_date = facts.referenceDate
    return doc
}

/** What to do to one store document so the order ends cancelled. */
export function cancelStep(docstatus: unknown): "delete" | "cancel" | "none" {
    const s = Number(docstatus)
    if (s === 0) return "delete"
    if (s === 1) return "cancel"
    return "none"
}

/** Payment Entries first: ERPNext will not cancel an invoice paid by one, nor an order its invoice bills. */
export const CANCEL_ORDER = [
    { doctype: PAYMENT_ENTRY_DOCTYPE, entity: PAYMENT_ENTITY },
    { doctype: "Sales Invoice", entity: "invoice" },
    { doctype: "Sales Order", entity: "order" },
] as const

/**
 * Whether the order's captured payments have been given back: "full"
 * when each was refunded in full, "partial" when some money went back but
 * not all of it, "none" otherwise.
 */
export function refundState(payments: CapturedPayment[] | null | undefined): "none" | "partial" | "full" {
    const captured = (payments ?? []).filter((p) => Number(p?.amount) > 0)
    if (!captured.length) return "none"
    const refunded = captured.map((p) => Number(p?.refunded) || 0)
    if (refunded.every((r) => r <= 0)) return "none"
    return captured.every((p, i) => refunded[i] >= Number(p.amount) - 0.01) ? "full" : "partial"
}

/** True when a push mapping listening on `events` handles `eventName`. A refund is handled where cancellation is. */
export function mappingHandlesEvent(events: unknown, eventName: string): boolean {
    if (!Array.isArray(events)) return false
    if (events.includes(eventName)) return true
    return eventName === ORDER_REFUNDED_EVENT && events.includes(ORDER_CANCELED_EVENT)
}
