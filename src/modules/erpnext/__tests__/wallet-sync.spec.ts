import { describe, expect, it } from "vitest"
import {
    compareBalances,
    customerOfWalletName,
    inboundKeyFor,
    isInboundRow,
    isWalletOrCreditDoctype,
    majorToMinor,
    minorToMajor,
    outboundKeyFor,
    planLoan,
    planOutboundWalletRow,
    planWalletStatus,
    planWalletTransaction,
    utrOf,
    walletWebhookSpecs,
    WALLET_CONDITION,
    WALLET_TXN_CONDITION,
    type MedusaWalletRow,
} from "../wallet-sync"

const WT = {
    name: "POL-WT-2026-00042",
    wallet: "WAL-CRN-01629",
    customer: "",
    docstatus: 1,
    txn_type: "Deposit",
    direction: "Credit",
    amount: 1200.5,
    origin: "ERPNext",
    remarks: "Wallet Deposit POL-WD-2026-00007 via Bank Transfer",
    reference_doctype: "Wallet Deposit",
    reference_name: "POL-WD-2026-00007",
    posting_datetime: "2026-09-27 12:00:00",
}

describe("money", () => {
    it("converts rupees to paise and back, rounding at the boundary", () => {
        expect(majorToMinor(1200.5)).toBe(120050)
        expect(majorToMinor("0.1")).toBe(10)
        expect(majorToMinor(null)).toBe(0)
        expect(minorToMajor(120050)).toBe(1200.5)
    })
})

describe("webhooks", () => {
    it("names the DocTypes and events, credit ones only when asked", () => {
        expect(walletWebhookSpecs({ wallet: true, credit: false }).map((s) => `${s.doctype} ${s.event}`)).toEqual([
            "Wallet Transaction on_submit",
            "Wallet on_update",
        ])
        expect(walletWebhookSpecs({ wallet: true, credit: true }).map((s) => `${s.doctype} ${s.event}`)).toContain("Loan on_update")
        expect(walletWebhookSpecs({ wallet: false, credit: false })).toEqual([])
    })
    it("excludes the connector's own rows at the source", () => {
        expect(WALLET_TXN_CONDITION).toContain('doc.get("origin") != "Medusa"')
        expect(WALLET_CONDITION).toContain("status")
        expect(isWalletOrCreditDoctype("Wallet Transaction")).toBe(true)
        expect(isWalletOrCreditDoctype("Loan")).toBe(true)
        expect(isWalletOrCreditDoctype("Item")).toBe(false)
    })
})

describe("planWalletTransaction (ERPNext → Medusa)", () => {
    it("applies an ERPNext deposit as a main-bucket credit keyed on the row", () => {
        const plan = planWalletTransaction({ event: "on_submit", doc: WT, link: null })
        expect(plan).toMatchObject({
            action: "credit",
            wallet: "WAL-CRN-01629",
            customer: "CRN-01629",
            amount_minor: 120050,
            kind: "deposit_credit",
            idempotency_key: "erpnext:wt:POL-WT-2026-00042",
        })
        expect((plan as any).metadata.reference_name).toBe("POL-WD-2026-00007")
    })
    it("maps each ERPNext transaction type to a Medusa kind", () => {
        const kind = (txn_type: string, direction: string) =>
            (planWalletTransaction({ event: "on_submit", doc: { ...WT, txn_type, direction }, link: null }) as any).kind
        expect(kind("Withdrawal", "Debit")).toBe("withdrawal_debit")
        expect(kind("Buy Settlement", "Debit")).toBe("order_debit")
        expect(kind("Fee", "Debit")).toBe("payin_fee_debit")
        expect(kind("Adjustment", "Credit")).toBe("manual_adjust")
        expect(kind("Reversal", "Credit")).toBe("refund")
        expect(kind("Reservation", "Debit")).toBe("manual_adjust")
        expect(kind("Reservation Release", "Credit")).toBe("refund")
    })
    it("never applies the connector's own rows, applied rows, drafts or unknown types", () => {
        expect(planWalletTransaction({ event: "on_submit", doc: { ...WT, origin: "Medusa" }, link: null })).toMatchObject({ action: "skip" })
        expect(planWalletTransaction({ event: "on_submit", doc: WT, link: { medusa_id: "tx_1" } })).toMatchObject({ action: "skip", reason: "already applied as tx_1" })
        expect(planWalletTransaction({ event: "on_submit", doc: { ...WT, docstatus: 0 }, link: null })).toMatchObject({ action: "skip" })
        expect(planWalletTransaction({ event: "on_trash", doc: WT, link: null })).toMatchObject({ action: "skip" })
        expect(planWalletTransaction({ event: "on_submit", doc: { ...WT, txn_type: "Mystery" }, link: null })).toMatchObject({ action: "skip" })
        expect(planWalletTransaction({ event: "on_submit", doc: { ...WT, amount: 0 }, link: null })).toMatchObject({ action: "skip" })
    })
    it("reads the customer off the wallet name when the row carries none", () => {
        expect(customerOfWalletName("WAL-CRN-01629")).toBe("CRN-01629")
        expect(customerOfWalletName("CRN-01629")).toBe(null)
        expect(inboundKeyFor("X")).toBe("erpnext:wt:X")
        expect(isInboundRow({ idempotency_key: "erpnext:wt:X" })).toBe(true)
        expect(isInboundRow({ idempotency_key: "order_1" })).toBe(false)
    })
})

describe("planWalletStatus and planLoan", () => {
    it("freezes on Frozen or Closed, unfreezes on Active", () => {
        expect(planWalletStatus({ name: "WAL-C1", status: "Frozen", medusa_id: "wal_1" })).toEqual({ action: "freeze", customer: "C1", wallet: "WAL-C1", medusa_id: "wal_1" })
        expect(planWalletStatus({ name: "WAL-C1", status: "Closed" })).toMatchObject({ action: "freeze" })
        expect(planWalletStatus({ name: "WAL-C1", status: "Active" })).toMatchObject({ action: "unfreeze" })
        expect(planWalletStatus({ name: "", status: "Active" })).toMatchObject({ action: "skip" })
    })
    it("announces a customer's Loan with its limits in minor units", () => {
        const plan = planLoan({ name: "ACC-LOAN-1", applicant_type: "Customer", applicant: "C1", status: "Sanctioned", maximum_limit_amount: 5000, available_limit_amount: 3800, utilized_limit_amount: 1200 })
        expect(plan).toMatchObject({ action: "announce", customer: "C1", loan: "ACC-LOAN-1", summary: { limit_minor: 500000, available_minor: 380000, utilized_minor: 120000 } })
        expect(planLoan({ name: "L", applicant_type: "Employee", applicant: "E" })).toMatchObject({ action: "skip" })
    })
})

const ROW: MedusaWalletRow = {
    id: "wtx_1",
    wallet_id: "wal_1",
    customer_id: "cus_1",
    direction: "debit",
    amount_minor: 150000,
    kind: "order_debit",
    bucket: "main",
    reference_type: "order",
    reference_id: "order_1",
    idempotency_key: "wlc_1:wallet",
    public_ref: "WADB-270926-0001",
    note: null,
    metadata: null,
}

describe("planOutboundWalletRow (Medusa → ERPNext)", () => {
    const base = { customer: "CRN-01629", company: "FIPL", link: null, paired: false, bank_account: null, posting_date: "2026-09-27" }
    it("sends an order debit as a Buy Settlement through the wallet-leg-only method", () => {
        const plan = planOutboundWalletRow({ ...base, row: ROW })
        expect(plan).toEqual({
            action: "method",
            method: "customer_wallet.api.wallet.debit",
            params: {
                customer: "CRN-01629",
                company: "FIPL",
                amount: 1500,
                idempotency_key: "medusa:wlc_1:wallet",
                txn_type: "Buy Settlement",
                origin: "Medusa",
                medusa_id: "wtx_1",
                remarks: "Medusa WADB-270926-0001 · order_debit · order order_1",
            },
        })
    })
    it("maps each Medusa kind to an ERPNext transaction type", () => {
        const type = (direction: "credit" | "debit", kind: string) => (planOutboundWalletRow({ ...base, row: { ...ROW, direction, kind } }) as any).params.txn_type
        expect(type("credit", "deposit_credit")).toBe("Deposit")
        expect(type("credit", "topup_credit")).toBe("Deposit")
        expect(type("credit", "refund")).toBe("Adjustment")
        expect(type("debit", "withdrawal_debit")).toBe("Withdrawal")
        expect(type("debit", "payout_fee_debit")).toBe("Fee")
        expect(type("debit", "manual_adjust")).toBe("Adjustment")
    })
    it("books a bank deposit as a Wallet Deposit document when the store names the account", () => {
        const row: MedusaWalletRow = { ...ROW, direction: "credit", kind: "deposit_credit", idempotency_key: "deposit_UTR123", metadata: null }
        expect(utrOf(row)).toBe("UTR123")
        const plan = planOutboundWalletRow({ ...base, row, bank_account: "HDFC Bank - FIPL" })
        expect(plan).toMatchObject({
            action: "deposit_document",
            body: { doctype: "Wallet Deposit", customer: "CRN-01629", amount: 1500, mode: "Bank Transfer", bank_or_cash_account: "HDFC Bank - FIPL", reference_no: "UTR123", origin: "Medusa", medusa_id: "wtx_1", docstatus: 1 },
        })
        // Without the account it is a wallet-leg-only Deposit.
        expect(planOutboundWalletRow({ ...base, row })).toMatchObject({ action: "method", method: "customer_wallet.api.wallet.credit", params: { txn_type: "Deposit" } })
    })
    it("never sends promo rows, inbound rows, paired rows or credit-line mirrors", () => {
        expect(planOutboundWalletRow({ ...base, row: { ...ROW, bucket: "promo" } })).toMatchObject({ action: "skip", reason: "promo bucket never syncs" })
        expect(planOutboundWalletRow({ ...base, row: { ...ROW, idempotency_key: "erpnext:wt:X" } })).toMatchObject({ action: "skip" })
        expect(planOutboundWalletRow({ ...base, row: ROW, link: { erpnext_name: "POL-WT-1" } })).toMatchObject({ action: "skip" })
        expect(planOutboundWalletRow({ ...base, row: ROW, paired: true })).toMatchObject({ action: "skip" })
        expect(planOutboundWalletRow({ ...base, row: { ...ROW, direction: "credit", kind: "grant_credit", metadata: { source: "credit_line_draw" } } })).toMatchObject({ action: "skip" })
        expect(planOutboundWalletRow({ ...base, row: { ...ROW, kind: "manual_adjust", metadata: { source: "credit_line_repayment" } } })).toMatchObject({ action: "skip" })
        // The order debit of the drawn amount DOES travel: ERPNext has the draw, not the spend.
        expect(planOutboundWalletRow({ ...base, row: { ...ROW, metadata: { source: "credit_line_draw" } } })).toMatchObject({ action: "method" })
    })
    it("keys on the row's own idempotency key, else its id", () => {
        expect(outboundKeyFor({ id: "wtx_1", idempotency_key: "k" })).toBe("medusa:k")
        expect(outboundKeyFor({ id: "wtx_1", idempotency_key: null })).toBe("medusa:wt:wtx_1")
    })
})

describe("compareBalances", () => {
    it("tells lag from drift", () => {
        expect(compareBalances({ medusa_main_minor: 100, erpnext_available_minor: 100, pending_outbound_minor: 0 })).toEqual({ state: "equal", delta_minor: 0 })
        // A Medusa debit of 30 not yet pushed: ERPNext still shows 130.
        expect(compareBalances({ medusa_main_minor: 100, erpnext_available_minor: 130, pending_outbound_minor: -30 })).toEqual({ state: "lagging", delta_minor: 30 })
        expect(compareBalances({ medusa_main_minor: 100, erpnext_available_minor: 130, pending_outbound_minor: 0 })).toEqual({ state: "drift", delta_minor: 30 })
    })
})
