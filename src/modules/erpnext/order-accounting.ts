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

import type { FrappeClient } from "./frappe-client"

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

/** What submitting a document means given where it stands. */
export function submitStep(docstatus: unknown): "submit" | "already" | "cancelled" {
    const s = Number(docstatus)
    if (s === 1) return "already"
    if (s === 2) return "cancelled"
    return "submit"
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

/**
 * Whether a paid order being cancelled must first be booked in full, so
 * ERPNext keeps the sale and its cancellation instead of no trace of
 * either. Only with payments recorded, and only while a document or a
 * captured payment's Payment Entry is still missing.
 */
export function bookBeforeCancel(args: {
    recordPayments: boolean
    payments: CapturedPayment[] | null | undefined
    hasSalesOrder: boolean
    hasInvoice: boolean
    bookedPaymentIds: string[]
}): boolean {
    if (!args.recordPayments) return false
    const captured = (args.payments ?? []).filter((p) => p?.id && Number(p?.amount) > 0)
    if (!captured.length) return false
    if (captured.some((p) => isCashOnDelivery(p.provider_id))) return !args.hasSalesOrder
    if (!args.hasSalesOrder || !args.hasInvoice) return true
    return captured.some((p) => !args.bookedPaymentIds.includes(String(p.id)))
}

/** True when a push mapping listening on `events` handles `eventName`. A refund is handled where cancellation is. */
export function mappingHandlesEvent(events: unknown, eventName: string): boolean {
    if (!Array.isArray(events)) return false
    if (events.includes(eventName)) return true
    return eventName === ORDER_REFUNDED_EVENT && events.includes(ORDER_CANCELED_EVENT)
}

const resource = (doctype: string, name?: string) =>
    `/api/resource/${encodeURIComponent(doctype)}${name ? `/${encodeURIComponent(name)}` : ""}`

type Failure = { ok: false; error: string; httpStatus?: number }
const failed = (error: string, status?: number): Failure => ({ ok: false, error, httpStatus: status || undefined })

/** Submit a draft. A submitted document is left as it is; a cancelled one is reported, not revived. */
export async function submitDocument(
    client: FrappeClient,
    doctype: string,
    name: string,
): Promise<{ ok: true; state: "submitted" | "already" | "cancelled" } | Failure> {
    const doc = await client.get(resource(doctype, name))
    if (doc.ok === false) return failed(doc.error, doc.status)
    const step = submitStep(doc.data?.docstatus)
    if (step !== "submit") return { ok: true, state: step }
    const res = await client.put(resource(doctype, name), { docstatus: 1 })
    if (res.ok === false) return failed(res.error, res.status)
    return { ok: true, state: "submitted" }
}

/**
 * A live Payment Entry that already pays this invoice under this
 * reference: one an attempt made but died before the link table heard
 * of it. Null when there is none, or ERPNext would not say.
 */
export async function findPaymentEntry(client: FrappeClient, invoice: string, reference: string): Promise<string | null> {
    const res = await client.get(resource(PAYMENT_ENTRY_DOCTYPE), {
        fields: JSON.stringify(["name"]),
        filters: JSON.stringify([
            ["reference_no", "=", reference],
            ["docstatus", "<", 2],
            ["Payment Entry Reference", "reference_name", "=", invoice],
        ]),
        limit_page_length: "1",
    })
    const name = res.ok === true && Array.isArray(res.data) ? res.data[0]?.name : null
    return name ? String(name) : null
}

/**
 * A draft Payment Entry (Receive) for one captured payment against a
 * submitted invoice. ERPNext's own `get_payment_entry` builds it, so its
 * outstanding amount and rounding set the figures; the account it pays
 * into is the Mode of Payment's default for the invoice's company.
 */
export async function createPaymentEntry(
    client: FrappeClient,
    args: { invoice: string; captured: number; mode: string; reference: string; referenceDate: string },
): Promise<{ ok: true; name: string; note?: string } | { ok: true; skip: string } | Failure> {
    const si = await client.get(resource("Sales Invoice", args.invoice))
    if (si.ok === false) return failed(`invoice ${args.invoice}: ${si.error}`, si.status)
    const amount = paymentAmount(args.captured, Number(si.data?.outstanding_amount))
    if (amount.ok === false) return amount
    if ("skip" in amount) return amount
    const company = si.data?.company ?? null
    const account = await client.post("/api/method/erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account", {
        mode_of_payment: args.mode,
        company,
    })
    if (account.ok === false) return failed(`Mode of Payment ${args.mode}: ${account.error}`, account.status)
    const paidTo = account.data?.account ? String(account.data.account) : null
    if (!paidTo) return failed(`Mode of Payment ${args.mode} has no default account for ${company}`)
    const built = await client.post("/api/method/erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry", {
        dt: "Sales Invoice",
        dn: args.invoice,
        bank_account: paidTo,
        ...(amount.partyAmount != null ? { party_amount: amount.partyAmount } : {}),
    })
    if (built.ok === false) return failed(built.error, built.status)
    const doc = preparePaymentEntry(built.data ?? {}, { mode: args.mode, reference: args.reference, referenceDate: args.referenceDate })
    const written = await client.post(resource(PAYMENT_ENTRY_DOCTYPE), doc)
    if (written.ok === false) return failed(written.error, written.status)
    if (!written.data?.name) return failed("ERPNext answered without a Payment Entry name")
    return { ok: true, name: String(written.data.name), ...(amount.note ? { note: amount.note } : {}) }
}

/** Take one document out of the books: a draft is deleted, a submitted one cancelled. */
export async function unwindDocument(
    client: FrappeClient,
    doctype: string,
    name: string,
): Promise<{ ok: true; done: "deleted" | "cancelled" | "already cancelled" | "missing" } | Failure> {
    const state = await client.get(resource(doctype, name))
    if (state.ok === false) return state.status === 404 ? { ok: true, done: "missing" } : failed(`${doctype} ${name}: ${state.error}`, state.status)
    const step = cancelStep(state.data?.docstatus)
    if (step === "none") return { ok: true, done: "already cancelled" }
    const res =
        step === "delete"
            ? await client.delete(resource(doctype, name))
            : await client.post("/api/method/frappe.client.cancel", { doctype, name })
    if (res.ok === false) return failed(`${doctype} ${name} not ${step === "delete" ? "deleted" : "cancelled"}: ${res.error}`, res.status)
    return { ok: true, done: step === "delete" ? "deleted" : "cancelled" }
}
