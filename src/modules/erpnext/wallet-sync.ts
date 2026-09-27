/**
 * Wallet and line of credit, both ways, against the `customer_wallet`
 * Frappe app (wallet DocTypes) and the Frappe `lending` app (the Loan).
 *
 * ERPNext is the source of truth for the line of credit; nothing here
 * keeps a credit ledger. The wallet is a ledger on BOTH sides — one
 * document per movement — and the connector keeps the two ledgers
 * equal by mirroring rows, never by copying a balance:
 *
 *   Medusa → ERPNext   a `wallet_transaction` row becomes a `Wallet
 *                      Transaction` through the app's wallet-leg-only
 *                      `credit` / `debit` / `reverse` methods (or a
 *                      `Wallet Deposit` document when the store names the
 *                      bank account a UTR-bearing deposit arrived in),
 *                      carrying `origin: Medusa` and `medusa_id`.
 *   ERPNext → Medusa   a `Wallet Transaction` webhook (on submit) becomes
 *                      a `credit` / `debit` on the Medusa wallet with the
 *                      idempotency key `erpnext:wt:<name>`; a `Wallet`
 *                      status change freezes or unfreezes; a `Loan` change
 *                      is announced on the event bus for the credit
 *                      provider's cache.
 *
 * Correlation is by id pairs in `erpnext_link` (doctype, ERPNext name,
 * Medusa id) and on the ERPNext row (`medusa_id`). Echo prevention needs
 * no window: a row the connector wrote carries `origin: Medusa`, and the
 * webhook condition never fires for it; a row the connector applied from
 * ERPNext is linked at once, and the push skips linked rows. The promo
 * bucket never syncs — it is store marketing credit, not money.
 *
 * Everything here is pure; the service reads and writes.
 */

import { z } from "zod"

export const WALLET_TXN_DOCTYPE = "Wallet Transaction"
export const WALLET_DOCTYPE = "Wallet"
export const LOAN_DOCTYPE = "Loan"
export const WALLET_DOCTYPES = new Set([WALLET_TXN_DOCTYPE, WALLET_DOCTYPE])
export const CREDIT_DOCTYPES = new Set([LOAN_DOCTYPE])

/** Origin the connector stamps on everything it writes to ERPNext. */
export const ORIGIN_MEDUSA = "Medusa"

/** The Medusa event a Loan change is announced on. */
export const CREDIT_LINE_UPDATED_EVENT = "erpnext.credit_line.updated"

export function isWalletDoctype(doctype: string | null | undefined): boolean {
    return WALLET_DOCTYPES.has(String(doctype ?? ""))
}
export function isCreditDoctype(doctype: string | null | undefined): boolean {
    return CREDIT_DOCTYPES.has(String(doctype ?? ""))
}
export function isWalletOrCreditDoctype(doctype: string | null | undefined): boolean {
    return isWalletDoctype(doctype) || isCreditDoctype(doctype)
}

// ── money ─────────────────────────────────────────────────────────────

const MINOR_PER_MAJOR = 100

/** Minor units from an ERPNext Currency value (a float or a numeric string). */
export function majorToMinor(major: unknown): number {
    const n = typeof major === "number" ? major : Number(major)
    if (!Number.isFinite(n)) return 0
    return Math.round(n * MINOR_PER_MAJOR)
}

/** Major units, two decimals, for an ERPNext Currency field. */
export function minorToMajor(minor: unknown): number {
    const n = typeof minor === "number" ? minor : Number(minor)
    if (!Number.isFinite(n)) return 0
    return Math.round(n) / MINOR_PER_MAJOR
}

// ── webhooks Set up ERPNext installs ──────────────────────────────────

/**
 * A `Wallet Transaction` is submitted by the app's engine the moment it
 * is posted, and never edited or cancelled after (a reversal is a new
 * row), so `on_submit` is the one event that says "a movement happened".
 * Rows the connector itself posted are excluded at the source.
 */
export const WALLET_TXN_CONDITION = `doc.get("origin") != "Medusa"`

/** A Wallet's status (Active / Frozen / Closed) and its balance columns
 *  change; only a status change is worth a delivery. */
export const WALLET_CONDITION = `doc.get("origin") != "Medusa" and (not doc.get_doc_before_save() or doc.get_doc_before_save().get("status") != doc.get("status"))`

/** A customer's line of credit: one Loan per customer on the company's
 *  Line of Credit product. Loans of other applicant types are not ours. */
export const LOAN_CONDITION = `doc.get("applicant_type") == "Customer"`

export type WalletWebhookSpec = { doctype: string; event: "on_submit" | "on_update" | "on_cancel"; condition: string }

/** Which Webhooks the wallet and credit sync need, for `buildWebhook`. */
export function walletWebhookSpecs(args: { wallet: boolean; credit: boolean }): WalletWebhookSpec[] {
    const out: WalletWebhookSpec[] = []
    if (args.wallet) {
        out.push({ doctype: WALLET_TXN_DOCTYPE, event: "on_submit", condition: WALLET_TXN_CONDITION })
        out.push({ doctype: WALLET_DOCTYPE, event: "on_update", condition: WALLET_CONDITION })
    }
    if (args.credit) {
        out.push({ doctype: LOAN_DOCTYPE, event: "on_update", condition: LOAN_CONDITION })
        out.push({ doctype: LOAN_DOCTYPE, event: "on_submit", condition: LOAN_CONDITION })
        out.push({ doctype: LOAN_DOCTYPE, event: "on_cancel", condition: LOAN_CONDITION })
    }
    return out
}

// ── ERPNext → Medusa ──────────────────────────────────────────────────

/** The Medusa ledger `kind` for an ERPNext (direction, txn_type). */
export type MedusaCreditKind = "deposit_credit" | "refund" | "manual_adjust" | "grant_credit"
export type MedusaDebitKind = "order_debit" | "manual_adjust" | "payin_fee_debit" | "payout_fee_debit" | "withdrawal_debit"

const CREDIT_KINDS: Record<string, MedusaCreditKind> = {
    Deposit: "deposit_credit",
    "Reservation Release": "refund",
    "Sell Payout": "grant_credit",
    "Fee Refund": "refund",
    Adjustment: "manual_adjust",
    Reversal: "refund",
}
const DEBIT_KINDS: Record<string, MedusaDebitKind> = {
    Withdrawal: "withdrawal_debit",
    Reservation: "manual_adjust",
    "Buy Settlement": "order_debit",
    Fee: "payin_fee_debit",
    Adjustment: "manual_adjust",
    Reversal: "manual_adjust",
}

/** The idempotency key a Medusa row applied from ERPNext carries. */
export function inboundKeyFor(walletTransactionName: string): string {
    return `erpnext:wt:${walletTransactionName}`
}

/** Was this Medusa row written by an inbound apply? Then it never pushes. */
export function isInboundRow(row: { idempotency_key?: string | null }): boolean {
    return String(row?.idempotency_key ?? "").startsWith("erpnext:")
}

/** The ERPNext Customer a wallet belongs to: `WAL-<customer>`. */
export function customerOfWalletName(wallet: string | null | undefined): string | null {
    const w = String(wallet ?? "")
    return w.startsWith("WAL-") && w.length > 4 ? w.slice(4) : null
}

export type WalletTxnPlan =
    | {
          action: "credit" | "debit"
          wallet: string
          customer: string
          amount_minor: number
          kind: MedusaCreditKind | MedusaDebitKind
          idempotency_key: string
          note: string
          metadata: Record<string, unknown>
      }
    | { action: "skip"; reason: string }

/**
 * What one `Wallet Transaction` webhook means for the Medusa wallet.
 *
 * Only the `available` balance is mirrored: a Reservation moves money
 * from available to reserved, which Medusa has no bucket for, so it
 * lands as a debit and its release as a credit — the available balance
 * agrees on both sides, which is what an order can spend.
 */
export function planWalletTransaction(args: {
    event: string
    doc: Record<string, any>
    link: { medusa_id: string } | null | undefined
}): WalletTxnPlan {
    const { event, doc, link } = args
    if (event !== "on_submit" && event !== "on_update" && event !== "after_insert") {
        return { action: "skip", reason: `${event} on a Wallet Transaction is not a movement` }
    }
    if (Number(doc?.docstatus ?? 1) !== 1) return { action: "skip", reason: "not submitted" }
    if (String(doc?.origin ?? "") === ORIGIN_MEDUSA) return { action: "skip", reason: "written by this store; not an echo to apply" }
    if (link?.medusa_id) return { action: "skip", reason: `already applied as ${link.medusa_id}` }
    const wallet = String(doc?.wallet ?? "")
    const customer = String(doc?.customer ?? "") || customerOfWalletName(wallet) || ""
    if (!wallet || !customer) return { action: "skip", reason: "no wallet on the row" }
    const amount_minor = majorToMinor(doc?.amount)
    if (amount_minor <= 0) return { action: "skip", reason: "zero amount" }
    const direction = String(doc?.direction ?? "")
    const txn_type = String(doc?.txn_type ?? "")
    const kind = direction === "Credit" ? CREDIT_KINDS[txn_type] : direction === "Debit" ? DEBIT_KINDS[txn_type] : undefined
    if (!kind) return { action: "skip", reason: `no Medusa kind for ${direction} ${txn_type}` }
    const name = String(doc?.name ?? "")
    const metadata: Record<string, unknown> = {
        source: "erpnext",
        erpnext_doctype: WALLET_TXN_DOCTYPE,
        erpnext_name: name,
        txn_type,
        reference_doctype: doc?.reference_doctype ?? null,
        reference_name: doc?.reference_name ?? null,
        reverses: doc?.reverses ?? null,
        posting_datetime: doc?.posting_datetime ?? null,
    }
    const note = String(doc?.remarks ?? "").trim() || `${txn_type} ${name} in ERPNext`
    return {
        action: direction === "Credit" ? "credit" : "debit",
        wallet,
        customer,
        amount_minor,
        kind,
        idempotency_key: inboundKeyFor(name),
        note: note.slice(0, 200),
        metadata,
    }
}

export type WalletStatusPlan = { action: "freeze" | "unfreeze"; customer: string; wallet: string; medusa_id: string | null } | { action: "skip"; reason: string }

/** A Wallet document changed: only its status matters here. */
export function planWalletStatus(doc: Record<string, any>): WalletStatusPlan {
    const wallet = String(doc?.name ?? "")
    const customer = String(doc?.customer ?? "") || customerOfWalletName(wallet) || ""
    if (!wallet || !customer) return { action: "skip", reason: "no wallet" }
    const status = String(doc?.status ?? "")
    const medusa_id = doc?.medusa_id ? String(doc.medusa_id) : null
    if (status === "Frozen" || status === "Closed") return { action: "freeze", customer, wallet, medusa_id }
    if (status === "Active") return { action: "unfreeze", customer, wallet, medusa_id }
    return { action: "skip", reason: `status ${status || "(blank)"}` }
}

/** What a Loan webhook carries for the store: the customer and the numbers. */
export function planLoan(doc: Record<string, any>): { action: "announce"; customer: string; loan: string; summary: Record<string, unknown> } | { action: "skip"; reason: string } {
    if (String(doc?.applicant_type ?? "") !== "Customer") return { action: "skip", reason: "not a customer's loan" }
    const customer = String(doc?.applicant ?? "")
    const loan = String(doc?.name ?? "")
    if (!customer || !loan) return { action: "skip", reason: "no applicant" }
    return {
        action: "announce",
        customer,
        loan,
        summary: {
            loan,
            status: doc?.status ?? null,
            docstatus: doc?.docstatus ?? null,
            limit_minor: majorToMinor(doc?.maximum_limit_amount),
            available_minor: majorToMinor(doc?.available_limit_amount),
            utilized_minor: majorToMinor(doc?.utilized_limit_amount),
            valid_from: doc?.limit_applicable_start ?? null,
            valid_to: doc?.limit_applicable_end ?? null,
            medusa_id: doc?.medusa_id ?? null,
        },
    }
}

// ── Medusa → ERPNext ──────────────────────────────────────────────────

/** A Medusa `wallet_transaction` row, the fields the push reads. */
export const MedusaWalletRow = z.object({
    id: z.string().min(1),
    wallet_id: z.string().min(1),
    customer_id: z.string().min(1),
    direction: z.enum(["credit", "debit"]),
    amount_minor: z.union([z.number(), z.string()]).transform((v) => Math.round(Number(v))),
    kind: z.string(),
    bucket: z.string().nullable().optional(),
    reference_type: z.string().nullable().optional(),
    reference_id: z.string().nullable().optional(),
    provider_event_id: z.string().nullable().optional(),
    idempotency_key: z.string().nullable().optional(),
    public_ref: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
    metadata: z.record(z.any()).nullable().optional(),
    created_at: z.union([z.date(), z.string()]).nullable().optional(),
})
/** Spelled out rather than inferred: this plugin compiles without
 *  strictNullChecks, under which zod's inferred keys all turn optional. */
export type MedusaWalletRow = {
    id: string
    wallet_id: string
    customer_id: string
    direction: "credit" | "debit"
    amount_minor: number
    kind: string
    bucket?: string | null
    reference_type?: string | null
    reference_id?: string | null
    provider_event_id?: string | null
    idempotency_key?: string | null
    public_ref?: string | null
    note?: string | null
    metadata?: Record<string, any> | null
    created_at?: Date | string | null
}

/** Parse a raw module row into a `MedusaWalletRow`. */
export function parseWalletRow(raw: unknown): { ok: true; row: MedusaWalletRow } | { ok: false; message: string } {
    const res = MedusaWalletRow.safeParse(raw)
    if (!res.success) {
        const first = res.error.issues[0]
        return { ok: false, message: `${first?.path?.join(".") || "row"}: ${first?.message ?? "invalid"}` }
    }
    return { ok: true, row: res.data as unknown as MedusaWalletRow }
}

/** The ERPNext (txn_type, direction) for a Medusa row. */
const ERPNEXT_TXN: Record<string, { txn_type: string; direction: "Credit" | "Debit" }> = {
    "credit:deposit_credit": { txn_type: "Deposit", direction: "Credit" },
    "credit:topup_credit": { txn_type: "Deposit", direction: "Credit" },
    "credit:refund": { txn_type: "Adjustment", direction: "Credit" },
    "credit:order_reversal": { txn_type: "Adjustment", direction: "Credit" },
    "credit:manual_adjust": { txn_type: "Adjustment", direction: "Credit" },
    "credit:grant_credit": { txn_type: "Adjustment", direction: "Credit" },
    "debit:order_debit": { txn_type: "Buy Settlement", direction: "Debit" },
    "debit:manual_adjust": { txn_type: "Adjustment", direction: "Debit" },
    "debit:payin_fee_debit": { txn_type: "Fee", direction: "Debit" },
    "debit:payout_fee_debit": { txn_type: "Fee", direction: "Debit" },
    "debit:withdrawal_debit": { txn_type: "Withdrawal", direction: "Debit" },
}

export type OutboundWalletPlan =
    | {
          action: "method"
          method: "customer_wallet.api.wallet.credit" | "customer_wallet.api.wallet.debit"
          params: Record<string, unknown>
      }
    | { action: "deposit_document"; body: Record<string, unknown> }
    | { action: "skip"; reason: string }

/** The bank UTR a deposit row carries, when it does. */
export function utrOf(row: MedusaWalletRow): string | null {
    const meta = row.metadata ?? {}
    const fromMeta = (meta.utr ?? meta.bank_reference ?? null) as string | null
    if (fromMeta) return String(fromMeta)
    const key = String(row.idempotency_key ?? "")
    if (key.startsWith("deposit_")) return key.slice("deposit_".length) || null
    return null
}

/**
 * Should this Medusa row travel, and what does it become?
 *
 * Never: the promo bucket (store credit, not money); a row an inbound
 * apply wrote (`erpnext:` keys); the mirror of a credit-line draw or
 * repayment, which ERPNext posted itself and paired by `medusa_id`; a
 * row already linked.
 */
export function planOutboundWalletRow(args: {
    row: MedusaWalletRow
    customer: string
    company: string | null
    link: { erpnext_name: string } | null | undefined
    /** ERPNext already holds a row for this key or id (looked up before the push). */
    paired: boolean
    /** The bank account a UTR-bearing deposit is booked into, when the store says. */
    bank_account: string | null
    posting_date: string
}): OutboundWalletPlan {
    const { row } = args
    if ((row.bucket ?? "main") !== "main") return { action: "skip", reason: "promo bucket never syncs" }
    if (isInboundRow(row)) return { action: "skip", reason: "applied from ERPNext; not sent back" }
    if (args.link?.erpnext_name) return { action: "skip", reason: `already ${args.link.erpnext_name}` }
    if (args.paired) return { action: "skip", reason: "ERPNext already holds this movement" }
    const source = String(row.metadata?.source ?? "")
    if (source === "credit_line_draw" && row.direction === "credit") return { action: "skip", reason: "the draw is ERPNext's own Wallet Deposit" }
    if (source === "credit_line_repayment") return { action: "skip", reason: "the repayment is ERPNext's own Wallet Withdrawal" }
    if (row.amount_minor <= 0) return { action: "skip", reason: "zero amount" }
    const map = ERPNEXT_TXN[`${row.direction}:${row.kind}`]
    if (!map) return { action: "skip", reason: `no ERPNext transaction type for ${row.direction} ${row.kind}` }

    const idempotency_key = outboundKeyFor(row)
    const remarks = describeRow(row)
    const utr = row.kind === "deposit_credit" ? utrOf(row) : null
    if (utr && args.bank_account) {
        return {
            action: "deposit_document",
            body: {
                doctype: "Wallet Deposit",
                customer: args.customer,
                ...(args.company ? { company: args.company } : {}),
                posting_date: args.posting_date,
                amount: minorToMajor(row.amount_minor),
                mode: "Bank Transfer",
                bank_or_cash_account: args.bank_account,
                reference_no: utr,
                remarks,
                origin: ORIGIN_MEDUSA,
                medusa_id: row.id,
                docstatus: 1,
            },
        }
    }
    return {
        action: "method",
        method: map.direction === "Credit" ? "customer_wallet.api.wallet.credit" : "customer_wallet.api.wallet.debit",
        params: {
            customer: args.customer,
            ...(args.company ? { company: args.company } : {}),
            amount: minorToMajor(row.amount_minor),
            idempotency_key,
            txn_type: map.txn_type,
            origin: ORIGIN_MEDUSA,
            medusa_id: row.id,
            remarks,
        },
    }
}

/** The key ERPNext stores for a Medusa row: the row's own key, else its id. */
export function outboundKeyFor(row: { id: string; idempotency_key?: string | null }): string {
    return row.idempotency_key ? `medusa:${row.idempotency_key}` : `medusa:wt:${row.id}`
}

function describeRow(row: MedusaWalletRow): string {
    const parts = [row.public_ref ?? row.id, row.kind]
    if (row.reference_type && row.reference_id) parts.push(`${row.reference_type} ${row.reference_id}`)
    if (row.note) parts.push(String(row.note))
    return `Medusa ${parts.join(" · ")}`.slice(0, 240)
}

/** Which ERPNext filter finds the pair of a Medusa row, for the paired check. */
export function pairFilterFor(row: { id: string; idempotency_key?: string | null }): unknown[] {
    return [["medusa_id", "=", row.id]]
}

// ── reconcile ─────────────────────────────────────────────────────────

/**
 * Do the two ledgers agree? Reported, never corrected: the balance
 * ERPNext shows is authoritative when they differ (the user's rule), and
 * an operator posts the Adjustment there, which then syncs down.
 * `pending` are rows still to push or apply, so a difference that the
 * pending rows explain is "lagging", not "drift".
 */
export function compareBalances(args: {
    medusa_main_minor: number
    erpnext_available_minor: number
    pending_outbound_minor: number
}): { state: "equal" | "lagging" | "drift"; delta_minor: number } {
    const delta = Math.round(args.erpnext_available_minor) - Math.round(args.medusa_main_minor)
    if (delta === 0) return { state: "equal", delta_minor: 0 }
    // Pending outbound rows are signed as they will move the ERPNext side.
    if (delta + Math.round(args.pending_outbound_minor) === 0) return { state: "lagging", delta_minor: delta }
    return { state: "drift", delta_minor: delta }
}
