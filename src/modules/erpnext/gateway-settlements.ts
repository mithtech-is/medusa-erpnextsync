/**
 * Payment-gateway settlements, booked in ERPNext.
 *
 * At capture each payment is received into its provider's Mode of Payment
 * account, a clearing account (order-accounting.ts). When the gateway pays
 * out, a settlement clears it in two documents:
 *   - a Purchase Invoice from the gateway for its fee, taxed the way
 *     India Compliance taxes a purchase from that supplier, paid at once
 *     from the clearing account so it never sits in payables;
 *   - a Journal Entry moving the net payout from the clearing account to
 *     the bank account it landed in.
 * Together they take gross - refunds + adjustments out of the clearing
 * account: what capture put in, less the refunds already unwound there.
 */

import type { FrappeClient } from "./frappe-client"
import { normalizePaymentModes } from "./order-accounting"

export const SETTLEMENT_EVENT = "payment_gateway.settlement_recorded"
/** The link table's entity for a settlement; its id is `<provider>:<settlement_id>`. */
export const SETTLEMENT_ENTITY = "gateway_settlement"

export const DEFAULT_SERVICE_ITEM = "Payment Gateway Charges"
/**
 * SAC for the gateway's fee on the service item Set up ERPNext creates.
 * A placeholder: the owner must confirm the code against the gateway's
 * own tax invoices before relying on it.
 */
export const DEFAULT_GATEWAY_SAC = "997158"

/** What the store buys from one gateway, and how the gateway is paid out. */
export type GatewaySupplier = {
    /** The ERPNext Supplier (its name or its supplier_name). */
    supplier: string
    /** The non-stock service Item the fee is billed as. */
    item: string
    /** HSN/SAC on that Item when Set up ERPNext creates it. */
    gst_hsn_code: string
    /** The Mode of Payment whose account the gateway's payments sit in;
     *  null finds it in the provider → Mode of Payment map. */
    mode_of_payment: string | null
}

export const DEFAULT_GATEWAY_SUPPLIERS: Readonly<Record<string, GatewaySupplier>> = Object.freeze({
    cashfree: {
        supplier: "Cashfree Payments India Private Limited",
        item: DEFAULT_SERVICE_ITEM,
        gst_hsn_code: DEFAULT_GATEWAY_SAC,
        mode_of_payment: null,
    },
})

/** The gateway → supplier map Settings holds; null means the default. */
export function normalizeGatewaySuppliers(raw: unknown): Record<string, GatewaySupplier> {
    let value = raw
    if (value === null || value === undefined) {
        return Object.fromEntries(Object.entries(DEFAULT_GATEWAY_SUPPLIERS).map(([k, v]) => [k, { ...v }]))
    }
    if (typeof value === "string") {
        try {
            value = JSON.parse(value)
        } catch {
            return {}
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")
    const out: Record<string, GatewaySupplier> = {}
    for (const [provider, entry] of Object.entries(value as Record<string, any>)) {
        const p = String(provider ?? "").trim().toLowerCase()
        const supplier = text(entry?.supplier)
        if (!p || !supplier) continue
        out[p] = {
            supplier,
            item: text(entry?.item) || DEFAULT_SERVICE_ITEM,
            gst_hsn_code: text(entry?.gst_hsn_code) || DEFAULT_GATEWAY_SAC,
            mode_of_payment: text(entry?.mode_of_payment) || null,
        }
    }
    return out
}

/**
 * The Mode of Payment a gateway's payments were received into. The
 * gateway's own row wins; else the provider → Mode of Payment map, under
 * the gateway's name or a Medusa provider id for it (`pp_cashfree-pg`
 * for "cashfree"). Two different modes for one gateway is no answer.
 */
export function modeForGateway(
    provider: string,
    gateway: GatewaySupplier | null | undefined,
    paymentModes: unknown,
): { ok: true; mode: string } | { ok: false; error: string } {
    if (gateway?.mode_of_payment) return { ok: true, mode: gateway.mode_of_payment }
    const modes = normalizePaymentModes(paymentModes)
    const p = String(provider ?? "").trim().toLowerCase()
    if (modes[p]) return { ok: true, mode: modes[p] }
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(`^pp_${escaped}([-_]|$)`, "i")
    const found = [...new Set(Object.entries(modes).filter(([id]) => pattern.test(id)).map(([, mode]) => mode))]
    if (found.length === 1) return { ok: true, mode: found[0] }
    if (found.length > 1) {
        return { ok: false, error: `payment providers for ${p} book to different Modes of Payment (${found.join(", ")}); name one on the gateway's row under Settings → Payments into ERPNext` }
    }
    return { ok: false, error: `no Mode of Payment for gateway ${p}; map it under Settings → Payments into ERPNext` }
}

export type SettlementConfig =
    | { action: "skip"; reason: string }
    | { action: "fail"; error: string }
    | { action: "book"; gateway: GatewaySupplier; mode: string; bankAccount: string }

/** Whether Settings book a gateway's settlements, and with what. */
export function settlementConfig(row: any, provider: string): SettlementConfig {
    if (!row?.book_settlements) {
        return { action: "skip", reason: "settlements are not booked (Settings → Gateway settlements into ERPNext)" }
    }
    const p = String(provider ?? "").trim().toLowerCase()
    const gateway = normalizeGatewaySuppliers(row.gateway_suppliers)[p]
    if (!gateway) {
        return { action: "fail", error: `no supplier for gateway ${p || "unknown"}; add it under Settings → Gateway settlements into ERPNext` }
    }
    const mode = modeForGateway(p, gateway, row.payment_modes)
    if (mode.ok === false) return { action: "fail", error: mode.error }
    const bankAccount = String(row.settlement_bank_account ?? "").trim()
    if (!bankAccount) {
        return { action: "fail", error: "no settlement bank account; set it under Settings → Gateway settlements into ERPNext" }
    }
    return { action: "book", gateway, mode: mode.mode, bankAccount }
}

// ─────────────────────────────────────────────────────────────────────
// Booking one settlement
// ─────────────────────────────────────────────────────────────────────

export const PURCHASE_INVOICE_DOCTYPE = "Purchase Invoice"
export const JOURNAL_ENTRY_DOCTYPE = "Journal Entry"
/** How far ERPNext's GST on the fee may drift from the gateway's before the invoice is held back, in rupees. */
export const GST_TOLERANCE = 1

const LINE_TYPES = ["payment", "refund", "adjustment", "chargeback"] as const
export type SettlementLineType = (typeof LINE_TYPES)[number]

export type SettlementLine = {
    type: string
    gateway_payment_id: string | null
    gateway_order_id: string | null
    medusa_payment_id: string | null
    medusa_order_id: string | null
    amount: number
    fee_amount: number
    fee_tax_amount: number
}

/** `payment_gateway.settlement_recorded`, as a payment plugin emits it. Amounts in rupees. */
export type Settlement = {
    provider: string
    settlement_id: string
    utr: string | null
    settled_at: string
    currency: string
    gross_amount: number
    fee_amount: number
    fee_tax_amount: number
    refund_amount: number
    adjustment_amount: number
    net_amount: number
    lines: SettlementLine[]
}

const round2 = (n: number) => Math.round(n * 100) / 100
const idText = (v: unknown) => (typeof v === "string" || (typeof v === "number" && Number.isFinite(v)) ? String(v).trim() : "")

/** The link table's id for a settlement. */
export function settlementKey(provider: string, settlementId: string): string {
    return `${provider}:${settlementId}`
}

/** The sync event's id: one row per settlement, which a re-emitted event updates. */
export function settlementEventId(raw: any): string {
    const provider = idText(raw?.provider).toLowerCase() || "unknown"
    const id = idText(raw?.settlement_id) || "unknown"
    return `settlement:${settlementKey(provider, id)}`
}

/** Read the event's payload; a missing figure is an error, never a zero. */
export function parseSettlement(raw: any): { ok: true; settlement: Settlement } | { ok: false; error: string } {
    const provider = idText(raw?.provider).toLowerCase()
    const settlementId = idText(raw?.settlement_id)
    if (!provider || !settlementId) return { ok: false, error: "the settlement names no provider or settlement_id" }
    const settledAt = String(raw?.settled_at ?? "")
    if (!settledAt || Number.isNaN(new Date(settledAt).getTime())) {
        return { ok: false, error: `settlement ${settlementId} has no valid settled_at` }
    }
    const amounts: Record<string, number> = {}
    for (const key of ["gross_amount", "fee_amount", "fee_tax_amount", "refund_amount", "adjustment_amount", "net_amount"]) {
        const v = raw?.[key]
        const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
        if (!Number.isFinite(n)) return { ok: false, error: `settlement ${settlementId} has no ${key}` }
        amounts[key] = round2(n)
    }
    if (!Array.isArray(raw?.lines)) return { ok: false, error: `settlement ${settlementId} has no lines` }
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? round2(Number(v)) : 0)
    const lines: SettlementLine[] = raw.lines.map((l: any) => ({
        type: String(l?.type ?? "").trim().toLowerCase(),
        gateway_payment_id: idText(l?.gateway_payment_id) || null,
        gateway_order_id: idText(l?.gateway_order_id) || null,
        medusa_payment_id: idText(l?.medusa_payment_id) || null,
        medusa_order_id: idText(l?.medusa_order_id) || null,
        amount: num(l?.amount),
        fee_amount: num(l?.fee_amount),
        fee_tax_amount: num(l?.fee_tax_amount),
    }))
    return {
        ok: true,
        settlement: {
            provider,
            settlement_id: settlementId,
            utr: idText(raw?.utr) || null,
            settled_at: settledAt,
            currency: String(raw?.currency ?? "").trim().toUpperCase(),
            gross_amount: amounts.gross_amount,
            fee_amount: amounts.fee_amount,
            fee_tax_amount: amounts.fee_tax_amount,
            refund_amount: amounts.refund_amount,
            adjustment_amount: amounts.adjustment_amount,
            net_amount: amounts.net_amount,
            lines,
        },
    }
}

export type SettlementPlan =
    | {
          ok: true
          /** The fee before GST: the Purchase Invoice's one line. */
          fee: number
          /** GST on the fee, as the gateway charged it. */
          feeTax: number
          /** What reached the bank: the Journal Entry. */
          net: number
          /** Posting, bill and cheque date: the settlement's day in the site's time zone. */
          date: string
          /** The UTR, else the settlement id: the Journal Entry's cheque number. */
          reference: string
          notes: string[]
      }
    | { ok: false; error: string }

/**
 * Whether a settlement can be booked as fee invoice plus payout, and with
 * which figures. Nothing is booked for a settlement that is not INR, that
 * carries a chargeback or an adjustment (the store cannot tell which sale
 * or earlier settlement they reverse), or whose figures do not add up to
 * the payout. A refund netted from the payout needs nothing of its own:
 * a payment refunded in full had its Payment Entry cancelled, which took
 * it back out of the clearing account.
 */
export function planSettlement(s: Settlement, date: string): SettlementPlan {
    const id = s.settlement_id
    const refuse = (why: string): SettlementPlan => ({
        ok: false,
        error: `settlement ${id}: ${why}; nothing was booked. Book it by hand in ERPNext, or replay once the settlement is corrected`,
    })
    if (s.currency !== "INR") return refuse(`currency ${s.currency || "missing"}, only INR is booked`)
    const unknown = [...new Set(s.lines.map((l) => l.type).filter((t) => !(LINE_TYPES as readonly string[]).includes(t)))]
    if (unknown.length) return refuse(`lines of unknown type ${unknown.join(", ")}`)
    const chargebacks = s.lines.filter((l) => l.type === "chargeback").length
    const adjustments = s.lines.filter((l) => l.type === "adjustment").length
    if (chargebacks || adjustments || Math.abs(s.adjustment_amount) > 0.005) {
        const what = [
            chargebacks ? `${chargebacks} chargeback line(s)` : "",
            adjustments ? `${adjustments} adjustment line(s)` : "",
            !adjustments && Math.abs(s.adjustment_amount) > 0.005 ? `an adjustment of ${s.adjustment_amount.toFixed(2)}` : "",
        ]
            .filter(Boolean)
            .join(" and ")
        return refuse(`it carries ${what}, which cannot be matched to the store's own entries`)
    }
    for (const key of ["gross_amount", "fee_amount", "fee_tax_amount", "refund_amount", "net_amount"] as const) {
        if (s[key] < 0) return refuse(`${key} is negative (${s[key].toFixed(2)})`)
    }
    const expected = round2(s.gross_amount - s.refund_amount - s.fee_amount - s.fee_tax_amount + s.adjustment_amount)
    if (Math.abs(expected - s.net_amount) > 0.01) {
        return refuse(
            `its figures do not add up: gross ${s.gross_amount.toFixed(2)} - refunds ${s.refund_amount.toFixed(2)} - fee ${s.fee_amount.toFixed(2)} - GST ${s.fee_tax_amount.toFixed(2)} = ${expected.toFixed(2)}, but the payout is ${s.net_amount.toFixed(2)}`,
        )
    }
    const notes: string[] = []
    if (s.refund_amount > 0) {
        notes.push(
            `refunds of ${s.refund_amount.toFixed(2)} netted from the payout; a payment refunded in part stays in the clearing account until the refund is booked in ERPNext`,
        )
    }
    return {
        ok: true,
        fee: s.fee_amount,
        feeTax: s.fee_tax_amount,
        net: s.net_amount,
        date,
        reference: s.utr || s.settlement_id,
        notes,
    }
}

/** "intra-state" when both GSTINs are in one state (CGST + SGST), "inter-state" (IGST) otherwise. */
export function supplyOf(companyGstin: unknown, supplierGstin: unknown): "intra-state" | "inter-state" | null {
    const state = (g: unknown) => {
        const m = /^(\d{2})[0-9A-Z]{13}$/.exec(String(g ?? "").trim().toUpperCase())
        return m ? m[1] : null
    }
    const a = state(companyGstin)
    const b = state(supplierGstin)
    if (!a || !b) return null
    return a === b ? "intra-state" : "inter-state"
}

/** What `get_party_details` says about the supplier that a Purchase Invoice keeps. */
const PARTY_FIELDS = [
    "supplier_address",
    "address_display",
    "contact_person",
    "billing_address",
    "billing_address_display",
    "shipping_address",
    "shipping_address_display",
    "tax_category",
    "place_of_supply",
    "company_gstin",
    "supplier_gstin",
    "gst_category",
] as const

const ROW_META = ["name", "parent", "parenttype", "parentfield", "idx", "docstatus", "owner", "creation", "modified", "modified_by", "doctype", "__islocal", "__unsaved"]

export type PartyTaxes = {
    template: string | null
    rows: any[]
    fields: Record<string, any>
    supply: "intra-state" | "inter-state" | null
}

export function buildPurchaseInvoice(args: {
    company: string
    supplier: string
    item: string
    fee: number
    date: string
    billNo: string
    clearingAccount: string
    mode: string
    remarks: string
    party: PartyTaxes
}): Record<string, any> {
    const fields: Record<string, any> = {}
    for (const k of PARTY_FIELDS) {
        const v = args.party.fields?.[k]
        if (v !== undefined && v !== null && v !== "") fields[k] = v
    }
    return {
        doctype: PURCHASE_INVOICE_DOCTYPE,
        company: args.company,
        supplier: args.supplier,
        ...fields,
        posting_date: args.date,
        set_posting_time: 1,
        bill_no: args.billNo,
        bill_date: args.date,
        due_date: args.date,
        currency: "INR",
        update_stock: 0,
        // The gateway charges to the paisa; a rounded total would leave the difference in the clearing account.
        disable_rounded_total: 1,
        is_paid: 1,
        mode_of_payment: args.mode,
        cash_bank_account: args.clearingAccount,
        remarks: args.remarks,
        items: [{ item_code: args.item, qty: 1, rate: args.fee }],
        taxes_and_charges: args.party.template,
        taxes: args.party.rows.map((r) => {
            const row = { ...r }
            for (const k of ROW_META) delete row[k]
            return row
        }),
    }
}

export function buildJournalEntry(args: {
    company: string
    date: string
    reference: string
    net: number
    bankAccount: string
    clearingAccount: string
    remark: string
}): Record<string, any> {
    return {
        doctype: JOURNAL_ENTRY_DOCTYPE,
        voucher_type: "Bank Entry",
        company: args.company,
        posting_date: args.date,
        cheque_no: args.reference,
        cheque_date: args.date,
        user_remark: args.remark,
        multi_currency: 0,
        accounts: [
            { account: args.bankAccount, debit_in_account_currency: args.net, credit_in_account_currency: 0 },
            { account: args.clearingAccount, debit_in_account_currency: 0, credit_in_account_currency: args.net },
        ],
    }
}

/** How a Purchase Invoice ERPNext holds differs from what the settlement now says; null when it does not. */
export function purchaseInvoiceDiffers(doc: Record<string, any>, plan: { fee: number; feeTax: number }): string | null {
    const fee = round2(Number(doc?.net_total ?? doc?.total) || 0)
    const tax = round2(Number(doc?.total_taxes_and_charges) || 0)
    if (Math.abs(fee - plan.fee) > 0.005) return `a fee of ${fee.toFixed(2)} where the settlement now says ${plan.fee.toFixed(2)}`
    if (Math.abs(tax - plan.feeTax) > GST_TOLERANCE) return `GST of ${tax.toFixed(2)} where the settlement now says ${plan.feeTax.toFixed(2)}`
    return null
}

/** How a Journal Entry ERPNext holds differs from the payout it should book; null when it does not. */
export function journalEntryDiffers(
    doc: Record<string, any>,
    want: { net: number; bankAccount: string; clearingAccount: string },
): string | null {
    const rows: any[] = Array.isArray(doc?.accounts) ? doc.accounts : []
    const sum = (account: string, side: "debit_in_account_currency" | "credit_in_account_currency") =>
        round2(rows.filter((r) => r?.account === account).reduce((t, r) => t + (Number(r?.[side]) || 0), 0))
    const debit = sum(want.bankAccount, "debit_in_account_currency")
    const credit = sum(want.clearingAccount, "credit_in_account_currency")
    if (Math.abs(debit - want.net) > 0.005 || Math.abs(credit - want.net) > 0.005) {
        return `${debit.toFixed(2)} into ${want.bankAccount} and ${credit.toFixed(2)} out of ${want.clearingAccount} where the payout is now ${want.net.toFixed(2)}`
    }
    return null
}

// ── Over REST ────────────────────────────────────────────────────────

type Failure = { ok: false; error: string; httpStatus?: number }
const failed = (error: string, status?: number): Failure => ({ ok: false, error, httpStatus: status || undefined })
const resource = (doctype: string, name?: string) =>
    `/api/resource/${encodeURIComponent(doctype)}${name ? `/${encodeURIComponent(name)}` : ""}`

/** The Supplier's name, given its name or its supplier_name (a site may name suppliers by series). */
export async function resolveSupplier(client: FrappeClient, supplier: string): Promise<{ ok: true; name: string | null } | Failure> {
    const direct = await client.get(resource("Supplier", supplier))
    if (direct.ok === true) return { ok: true, name: String(direct.data?.name ?? supplier) }
    if (direct.status !== 404) return failed(`Supplier ${supplier}: ${direct.error}`, direct.status)
    const byTitle = await client.get(resource("Supplier"), {
        fields: JSON.stringify(["name"]),
        filters: JSON.stringify([["supplier_name", "=", supplier]]),
        limit_page_length: "1",
    })
    if (byTitle.ok === false) return failed(`Supplier ${supplier}: ${byTitle.error}`, byTitle.status)
    const name = Array.isArray(byTitle.data) ? byTitle.data[0]?.name : null
    return { ok: true, name: name ? String(name) : null }
}

/** The default account of a Mode of Payment for a company: where the gateway's payments were received. */
export async function clearingAccountOf(client: FrappeClient, mode: string, company: string): Promise<{ ok: true; account: string } | Failure> {
    const res = await client.post("/api/method/erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account", {
        mode_of_payment: mode,
        company,
    })
    if (res.ok === false) return failed(`Mode of Payment ${mode}: ${res.error}`, res.status)
    const account = res.data?.account ? String(res.data.account) : null
    if (!account) return failed(`Mode of Payment ${mode} has no default account for ${company}`)
    return { ok: true, account }
}

/**
 * The purchase taxes ERPNext's own form would put on the fee invoice:
 * India Compliance picks the In-state or Out-state purchase template
 * inside `get_party_details`, from the supplier's GSTIN and address and
 * the company's.
 */
export async function purchaseTaxes(
    client: FrappeClient,
    args: { supplier: string; company: string; date: string; companyAddress: string | null },
): Promise<({ ok: true } & PartyTaxes) | Failure> {
    const res = await client.post("/api/method/erpnext.accounts.party.get_party_details", {
        party: args.supplier,
        party_type: "Supplier",
        doctype: PURCHASE_INVOICE_DOCTYPE,
        company: args.company,
        posting_date: args.date,
        bill_date: args.date,
        company_address: args.companyAddress,
    })
    if (res.ok === false) return failed(`purchase taxes for ${args.supplier}: ${res.error}`, res.status)
    const data = res.data ?? {}
    return {
        ok: true,
        template: data.taxes_and_charges ? String(data.taxes_and_charges) : null,
        rows: Array.isArray(data.taxes) ? data.taxes : [],
        fields: data,
        supply: supplyOf(data.company_gstin, data.supplier_gstin),
    }
}

/** The settlement's documents the link table knows, by DocType. */
export type SettlementLinks = {
    get(doctype: string): Promise<string | null>
    record(doctype: string, name: string): Promise<void>
    drop(doctype: string): Promise<void>
}

export type SettlementContext = {
    settlement: Settlement
    plan: Extract<SettlementPlan, { ok: true }>
    gateway: GatewaySupplier
    mode: string
    company: string
    companyAddress: string | null
    bankAccount: string
    links: SettlementLinks
}

type Step = { ok: true; changed: boolean; notes: string[] } | Failure

/**
 * The document a settlement already has in ERPNext: from the link table,
 * else found by its own reference (an attempt that died before the link
 * was written). A cancelled one is reported, never revived.
 */
async function existingDoc(
    client: FrappeClient,
    doctype: string,
    links: SettlementLinks,
    find: () => Promise<string | null>,
): Promise<{ ok: true; name: string | null; doc: Record<string, any> | null; cancelled?: boolean } | Failure> {
    let name = await links.get(doctype)
    if (name) {
        const got = await client.get(resource(doctype, name))
        if (got.ok === false && got.status !== 404) return failed(`${doctype} ${name}: ${got.error}`, got.status)
        if (got.ok === false) {
            await links.drop(doctype)
            name = null
        } else {
            return { ok: true, name, doc: got.data ?? {}, cancelled: Number(got.data?.docstatus) === 2 }
        }
    }
    name = await find()
    if (!name) return { ok: true, name: null, doc: null }
    const got = await client.get(resource(doctype, name))
    if (got.ok === false) return failed(`${doctype} ${name}: ${got.error}`, got.status)
    await links.record(doctype, name)
    return { ok: true, name, doc: got.data ?? {} }
}

/** A draft is written over; a new document is inserted as a draft. */
async function writeDraft(
    client: FrappeClient,
    doctype: string,
    name: string | null,
    payload: Record<string, any>,
): Promise<{ ok: true; name: string; doc: Record<string, any> } | Failure> {
    if (name) {
        const { doctype: _omit, ...patch } = payload
        const put = await client.put(resource(doctype, name), patch)
        if (put.ok === false) return failed(`${doctype} ${name} not updated: ${put.error}`, put.status)
        return { ok: true, name, doc: put.data ?? {} }
    }
    const made = await client.post(resource(doctype), payload)
    if (made.ok === false) return failed(`${doctype} not created: ${made.error}`, made.status)
    if (!made.data?.name) return failed(`ERPNext answered without a ${doctype} name`)
    return { ok: true, name: String(made.data.name), doc: made.data }
}

async function submit(client: FrappeClient, doctype: string, name: string): Promise<{ ok: true; state: string } | Failure> {
    const got = await client.get(resource(doctype, name))
    if (got.ok === false) return failed(`${doctype} ${name}: ${got.error}`, got.status)
    const status = Number(got.data?.docstatus)
    if (status === 1) return { ok: true, state: "already submitted" }
    if (status === 2) return { ok: true, state: "cancelled" }
    const res = await client.put(resource(doctype, name), { docstatus: 1 })
    if (res.ok === false) return failed(`${doctype} ${name} not submitted: ${res.error}`, res.status)
    return { ok: true, state: "submitted" }
}

function remarkOf(s: Settlement): string {
    return `${s.provider} settlement ${s.settlement_id}${s.utr ? `, UTR ${s.utr}` : ""}`
}

/**
 * The gateway's fee as a Purchase Invoice paid at once from the clearing
 * account. ERPNext computes the GST; one more than a rupee away from what
 * the gateway charged keeps the invoice a draft and fails the step.
 */
async function settlePurchaseInvoice(client: FrappeClient, ctx: SettlementContext, clearing: string, supplier: string): Promise<Step> {
    const { settlement: s, plan } = ctx
    const found = await existingDoc(client, PURCHASE_INVOICE_DOCTYPE, ctx.links, async () => {
        const res = await client.get(resource(PURCHASE_INVOICE_DOCTYPE), {
            fields: JSON.stringify(["name"]),
            filters: JSON.stringify([
                ["supplier", "=", supplier],
                ["bill_no", "=", s.settlement_id],
                ["docstatus", "<", 2],
            ]),
            limit_page_length: "1",
        })
        const name = res.ok === true && Array.isArray(res.data) ? res.data[0]?.name : null
        return name ? String(name) : null
    })
    if (found.ok === false) return found
    if (found.cancelled) {
        return { ok: true, changed: false, notes: [`Purchase Invoice ${found.name} for the fee is cancelled in ERPNext; not made again`] }
    }
    if (found.doc && Number(found.doc.docstatus) === 1) {
        const diff = purchaseInvoiceDiffers(found.doc, plan)
        if (diff) {
            return failed(
                `Purchase Invoice ${found.name} for settlement ${s.settlement_id} is submitted with ${diff}; cancel and amend it in ERPNext, then replay this event`,
            )
        }
        return { ok: true, changed: false, notes: [`Purchase Invoice ${found.name} for the fee already submitted`] }
    }

    const taxes = await purchaseTaxes(client, { supplier, company: ctx.company, date: plan.date, companyAddress: ctx.companyAddress })
    if (taxes.ok === false) return taxes
    const payload = buildPurchaseInvoice({
        company: ctx.company,
        supplier,
        item: ctx.gateway.item,
        fee: plan.fee,
        date: plan.date,
        billNo: s.settlement_id,
        clearingAccount: clearing,
        mode: ctx.mode,
        remarks: `Gateway charges, ${remarkOf(s)}`,
        party: taxes,
    })
    const written = await writeDraft(client, PURCHASE_INVOICE_DOCTYPE, found.name, payload)
    if (written.ok === false) return written
    if (!found.name) await ctx.links.record(PURCHASE_INVOICE_DOCTYPE, written.name)

    const computed = round2(Number(written.doc.total_taxes_and_charges) || 0)
    if (Math.abs(computed - plan.feeTax) > GST_TOLERANCE) {
        return failed(
            `Purchase Invoice ${written.name} kept as a draft: ERPNext's GST on the fee is ${computed.toFixed(2)} but the settlement charged ${plan.feeTax.toFixed(2)}. ` +
                `Check the supplier's GSTIN and address (India Compliance picks the purchase taxes from them) and the item's tax template, then replay this event`,
        )
    }
    const grand = round2(Number(written.doc.grand_total) || 0)
    if (Math.abs((Number(written.doc.paid_amount) || 0) - grand) > 0.005) {
        const paid = await client.put(resource(PURCHASE_INVOICE_DOCTYPE, written.name), {
            paid_amount: grand,
            base_paid_amount: round2(Number(written.doc.base_grand_total) || grand),
        })
        if (paid.ok === false) return failed(`Purchase Invoice ${written.name} not marked paid: ${paid.error}`, paid.status)
    }
    const done = await submit(client, PURCHASE_INVOICE_DOCTYPE, written.name)
    if (done.ok === false) return done
    const supply = taxes.supply ? `, ${taxes.supply} GST ${computed.toFixed(2)}` : `, GST ${computed.toFixed(2)}`
    return {
        ok: true,
        changed: true,
        notes: [`Purchase Invoice ${written.name} ${done.state}: fee ${plan.fee.toFixed(2)}${supply}, ${grand.toFixed(2)} paid from ${clearing}`],
    }
}

/** The payout as a Journal Entry from the clearing account to the bank, the UTR as cheque number. */
async function settleJournalEntry(client: FrappeClient, ctx: SettlementContext, clearing: string): Promise<Step> {
    const { settlement: s, plan } = ctx
    if (plan.net <= 0.005) return { ok: true, changed: false, notes: ["no payout to book"] }
    const want = { net: plan.net, bankAccount: ctx.bankAccount, clearingAccount: clearing }
    const found = await existingDoc(client, JOURNAL_ENTRY_DOCTYPE, ctx.links, async () => {
        const res = await client.get(resource(JOURNAL_ENTRY_DOCTYPE), {
            fields: JSON.stringify(["name"]),
            filters: JSON.stringify([
                ["cheque_no", "=", plan.reference],
                ["docstatus", "<", 2],
                ["user_remark", "like", `%${s.settlement_id}%`],
            ]),
            limit_page_length: "1",
        })
        const name = res.ok === true && Array.isArray(res.data) ? res.data[0]?.name : null
        return name ? String(name) : null
    })
    if (found.ok === false) return found
    if (found.cancelled) {
        return { ok: true, changed: false, notes: [`Journal Entry ${found.name} for the payout is cancelled in ERPNext; not made again`] }
    }
    if (found.doc && Number(found.doc.docstatus) === 1) {
        const diff = journalEntryDiffers(found.doc, want)
        if (diff) {
            return failed(
                `Journal Entry ${found.name} for settlement ${s.settlement_id} is submitted with ${diff}; cancel and amend it in ERPNext, then replay this event`,
            )
        }
        return { ok: true, changed: false, notes: [`Journal Entry ${found.name} for the payout already submitted`] }
    }
    const payload = buildJournalEntry({
        company: ctx.company,
        date: plan.date,
        reference: plan.reference,
        net: plan.net,
        bankAccount: ctx.bankAccount,
        clearingAccount: clearing,
        remark: `Payout of ${remarkOf(s)}`,
    })
    const written = await writeDraft(client, JOURNAL_ENTRY_DOCTYPE, found.name, payload)
    if (written.ok === false) return written
    if (!found.name) await ctx.links.record(JOURNAL_ENTRY_DOCTYPE, written.name)
    const done = await submit(client, JOURNAL_ENTRY_DOCTYPE, written.name)
    if (done.ok === false) return done
    return {
        ok: true,
        changed: true,
        notes: [`Journal Entry ${written.name} ${done.state}: ${plan.net.toFixed(2)} from ${clearing} to ${ctx.bankAccount}, reference ${plan.reference}`],
    }
}

/**
 * Book one settlement: the fee invoice, then the payout. Everything that
 * can stop it — the clearing account, the bank account, the supplier — is
 * checked before the first write, so a refusal posts nothing.
 */
export async function bookSettlementDocuments(
    client: FrappeClient,
    ctx: SettlementContext,
): Promise<{ ok: true; action: "booked" | "unchanged"; notes: string[] } | Failure> {
    const clearing = await clearingAccountOf(client, ctx.mode, ctx.company)
    if (clearing.ok === false) return clearing
    if (clearing.account === ctx.bankAccount) {
        return failed(`the settlement bank account ${ctx.bankAccount} is the clearing account of Mode of Payment ${ctx.mode}; name the account payouts land in`)
    }
    const bank = await client.get(resource("Account", ctx.bankAccount))
    if (bank.ok === false) {
        return bank.status === 404
            ? failed(`settlement bank account ${ctx.bankAccount} is not in ERPNext; create it, or let Set up ERPNext create it`)
            : failed(`Account ${ctx.bankAccount}: ${bank.error}`, bank.status)
    }
    const needsInvoice = ctx.plan.fee + ctx.plan.feeTax > 0.005
    let supplier: string | null = null
    if (needsInvoice) {
        const found = await resolveSupplier(client, ctx.gateway.supplier)
        if (found.ok === false) return found
        if (!found.name) return failed(`Supplier ${ctx.gateway.supplier} is not in ERPNext; run Set up ERPNext or create it`)
        supplier = found.name
    }

    const notes = [...ctx.plan.notes]
    let changed = false
    if (supplier) {
        const pi = await settlePurchaseInvoice(client, ctx, clearing.account, supplier)
        if (pi.ok === false) return pi
        changed ||= pi.changed
        notes.push(...pi.notes)
    } else {
        notes.push("no gateway charges to invoice")
    }
    const je = await settleJournalEntry(client, ctx, clearing.account)
    if (je.ok === false) return je
    changed ||= je.changed
    notes.push(...je.notes)
    return { ok: true, action: changed ? "booked" : "unchanged", notes }
}
