import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeFrappeClient, type FrappeClient } from "../src/modules/erpnext/frappe-client"
import { buildWalletWebhooks } from "../src/modules/erpnext/erpnext-setup"
import { frappeSignature, parseFrappeWebhookBody } from "../src/modules/erpnext/frappe-webhook"
import {
    LOAN_DOCTYPE,
    WALLET_DOCTYPE,
    WALLET_TXN_DOCTYPE,
    compareBalances,
    majorToMinor,
    outboundKeyFor,
    planLoan,
    planOutboundWalletRow,
    planWalletStatus,
    planWalletTransaction,
    type MedusaWalletRow,
} from "../src/modules/erpnext/wallet-sync"

/**
 * The wallet and credit seam, rehearsed against a live site running the
 * `customer_wallet` app (fixerp.localhost while developing):
 *
 *   ERPNEXT_URL=http://fixerp.localhost:8002 ERPNEXT_API_KEY=… ERPNEXT_API_SECRET=… \
 *   ERPNEXT_TEST_CUSTOMER=CRN-01629 npm run rehearsal
 *
 * Outbound: Medusa-shaped wallet rows are posted through exactly the calls
 * the push makes, replayed, reversed. Inbound: the Wallet Transaction,
 * Wallet and Loan documents ERPNext holds are turned into the webhook
 * bodies Frappe would send and planned. The credit line is drawn on and
 * repaid through the app's own methods.
 *
 * Nothing posted is cancelled. A submitted Wallet Transaction is
 * append-only, so the wallet is put back by reversal; a draw and its
 * repayment net to zero on the Loan and stay as lending documents, because
 * cancelling a Loan Disbursement needs cancel rights on Loan Repayment
 * Schedule that the API user lacks (and the sync never needs). Cancelling
 * only the repayment, as an earlier version did, left every rehearsal's
 * draw outstanding and used up the test line. The last test asserts that
 * the wallet and the line end where they began; a cleanup failure is
 * printed, never swallowed.
 */
const URL_ = process.env.ERPNEXT_URL
const KEY = process.env.ERPNEXT_API_KEY
const SECRET = process.env.ERPNEXT_API_SECRET
const CUSTOMER = process.env.ERPNEXT_TEST_CUSTOMER
const live = Boolean(URL_ && KEY && SECRET && CUSTOMER)

const enc = encodeURIComponent

function ok<T = any>(res: any, what: string): T {
    if (res?.ok !== true) throw new Error(`${what}: ${res?.error ?? "failed"}`)
    return res.data as T
}

async function listWt(client: FrappeClient, filters: unknown[]): Promise<any[]> {
    return ok(
        await client.get(`/api/resource/${enc(WALLET_TXN_DOCTYPE)}`, {
            filters: JSON.stringify(filters),
            fields: JSON.stringify(["name", "wallet", "txn_type", "direction", "amount", "origin", "medusa_id", "idempotency_key", "is_cancelled", "docstatus", "remarks", "reverses"]),
            limit_page_length: "20",
            order_by: "creation desc",
        }),
        "list Wallet Transaction",
    )
}

/** The body Frappe's `Medusa Sync: <DocType> <event>` webhook posts for a document. */
function webhookBody(event: string, doctype: string, doc: any) {
    const raw = Buffer.from(JSON.stringify({ event, doctype, name: doc.name, doc }))
    const parsed = parseFrappeWebhookBody(raw)
    if (parsed.ok === false) throw new Error(parsed.message)
    return { body: parsed.body, signature: frappeSignature(raw, "rehearsal-secret") }
}

describe.skipIf(!live)("wallet and credit line against a live customer_wallet site", () => {
    const client = makeFrappeClient({ baseUrl: URL_!, token: `${KEY}:${SECRET}`, timeoutMs: 60_000 })
    const stamp = Date.now().toString(36)
    const customer = CUSTOMER!
    const walletName = `WAL-${customer}`
    const cleanup: Array<{ what: string; run: () => Promise<unknown> }> = []
    let previousMedusaId: string | null = null
    let company: string | null = null

    beforeAll(async () => {
        const wallet = ok(await client.get(`/api/resource/${enc(WALLET_DOCTYPE)}/${enc(walletName)}`), "read Wallet")
        previousMedusaId = wallet.medusa_id ?? null
        company = wallet.company ?? null
        expect(wallet.status).toBe("Active")
    })

    afterAll(async () => {
        for (const step of cleanup.reverse()) {
            try {
                await step.run()
            } catch (err) {
                console.warn(`cleanup: could not ${step.what}: ${(err as Error).message}`)
            }
        }
        await client.put(`/api/resource/${enc(WALLET_DOCTYPE)}/${enc(walletName)}`, { medusa_id: previousMedusaId })
    })

    it("Set up ERPNext would install the wallet and credit webhooks with source-side echo exclusion", () => {
        const hooks = buildWalletWebhooks({ wallet: true, credit: true, publicUrl: "https://store.example", secret: "s" })
        expect(hooks.map((h) => h.name)).toEqual([
            "Medusa Sync: Wallet Transaction on_submit",
            "Medusa Sync: Wallet on_update",
            "Medusa Sync: Loan on_update",
            "Medusa Sync: Loan on_submit",
            "Medusa Sync: Loan on_cancel",
        ])
        expect(hooks[0].condition).toContain('doc.get("origin") != "Medusa"')
        expect(hooks[0].request_url).toBe("https://store.example/webhooks/erpnext-inbound")
    })

    it("pairs the two wallets by id", async () => {
        ok(await client.put(`/api/resource/${enc(WALLET_DOCTYPE)}/${enc(walletName)}`, { medusa_id: `wal_${stamp}` }), "stamp Wallet.medusa_id")
        const rows = ok(
            await client.get(`/api/resource/${enc(WALLET_DOCTYPE)}`, { filters: JSON.stringify([["medusa_id", "=", `wal_${stamp}`]]), fields: JSON.stringify(["name", "customer"]) }),
            "find Wallet by medusa_id",
        )
        expect(rows).toEqual([{ name: walletName, customer }])
    })

    it("pushes Medusa wallet rows as ERPNext movements, replays a repeated key, never posts twice", async () => {
        const before = ok(await client.get(`/api/resource/${enc(WALLET_DOCTYPE)}/${enc(walletName)}`), "read Wallet").balance_available
        const deposit: MedusaWalletRow = { id: `wtx_${stamp}_1`, wallet_id: `wal_${stamp}`, customer_id: `cus_${stamp}`, direction: "credit", amount_minor: 250_075, kind: "deposit_credit", bucket: "main", idempotency_key: `deposit_UTR${stamp}`, public_ref: "WACR-270926-9001", note: null, metadata: null }
        const plan = planOutboundWalletRow({ row: deposit, customer, company, link: null, paired: false, bank_account: null, posting_date: "2026-09-27" })
        expect(plan.action).toBe("method")
        if (plan.action !== "method") return
        const first = ok(await client.post(`/api/method/${plan.method}`, plan.params), "credit")
        expect(first.replayed).toBe(false)
        expect(first.wallet_transaction).toMatch(/^POL-WT-/)
        const again = ok(await client.post(`/api/method/${plan.method}`, plan.params), "credit again")
        expect(again.replayed).toBe(true)
        expect(again.wallet_transaction).toBe(first.wallet_transaction)

        const [row] = await listWt(client, [["medusa_id", "=", deposit.id]])
        expect(row).toMatchObject({ txn_type: "Deposit", direction: "Credit", amount: 2500.75, origin: "Medusa", medusa_id: deposit.id, idempotency_key: outboundKeyFor(deposit) })
        expect(majorToMinor(ok(await client.get(`/api/resource/${enc(WALLET_DOCTYPE)}/${enc(walletName)}`), "read Wallet").balance_available)).toBe(majorToMinor(before) + 250_075)

        // The store spends it: a Buy Settlement. Then the order is cancelled: reversed by pair.
        const debit: MedusaWalletRow = { id: `wtx_${stamp}_2`, wallet_id: `wal_${stamp}`, customer_id: `cus_${stamp}`, direction: "debit", amount_minor: 100_000, kind: "order_debit", bucket: "main", reference_type: "order", reference_id: "order_1", idempotency_key: `wlc_${stamp}:wallet`, public_ref: null, note: null, metadata: null }
        const debitPlan = planOutboundWalletRow({ row: debit, customer, company, link: null, paired: false, bank_account: null, posting_date: "2026-09-27" })
        expect(debitPlan).toMatchObject({ action: "method", method: "customer_wallet.api.wallet.debit", params: { txn_type: "Buy Settlement", amount: 1000 } })
        if (debitPlan.action !== "method") return
        const spent = ok(await client.post(`/api/method/${debitPlan.method}`, debitPlan.params), "debit")
        expect(spent.replayed).toBe(false)
        const reversed = ok(await client.post(`/api/method/customer_wallet.api.wallet.reverse`, { medusa_id: debit.id, remarks: "rehearsal: order cancelled" }), "reverse")
        expect(reversed.reversed).toBe(spent.wallet_transaction)
        const twice = await client.post(`/api/method/customer_wallet.api.wallet.reverse`, { medusa_id: debit.id })
        expect(twice.ok).toBe(false)

        // Put the deposit back so the wallet ends where it began.
        const undo = ok(await client.post(`/api/method/customer_wallet.api.wallet.reverse`, { wallet_transaction: first.wallet_transaction, remarks: "rehearsal cleanup" }), "reverse deposit")
        expect(undo.reversed_by).toMatch(/^POL-WT-/)
        expect(majorToMinor(ok(await client.get(`/api/resource/${enc(WALLET_DOCTYPE)}/${enc(walletName)}`), "read Wallet").balance_available)).toBe(majorToMinor(before))
        // A debit that would overdraw is refused and posts nothing.
        const over = await client.post(`/api/method/customer_wallet.api.wallet.debit`, { customer, amount: 99_999_999, idempotency_key: `medusa:over_${stamp}`, txn_type: "Adjustment", origin: "Medusa", medusa_id: `wtx_${stamp}_over` })
        expect(over.ok).toBe(false)
        expect(await listWt(client, [["medusa_id", "=", `wtx_${stamp}_over`]])).toEqual([])
    })

    it("plans ERPNext's own rows as Medusa credits and debits, and never its own echoes", async () => {
        const rows = await listWt(client, [["wallet", "=", walletName]])
        expect(rows.length).toBeGreaterThan(0)
        const own = rows.filter((r) => r.origin === "Medusa")
        const theirs = rows.filter((r) => r.origin !== "Medusa" && r.docstatus === 1)
        for (const r of own) {
            expect(planWalletTransaction({ event: "on_submit", doc: r, link: null })).toMatchObject({ action: "skip", reason: "written by this store; not an echo to apply" })
        }
        for (const r of theirs) {
            const { body } = webhookBody("on_submit", WALLET_TXN_DOCTYPE, r)
            const plan = planWalletTransaction({ event: body.event, doc: body.doc, link: null })
            if (plan.action === "skip") continue
            expect(plan.wallet).toBe(walletName)
            expect(plan.customer).toBe(customer)
            expect(plan.amount_minor).toBe(majorToMinor(r.amount))
            expect(plan.idempotency_key).toBe(`erpnext:wt:${r.name}`)
            expect(planWalletTransaction({ event: body.event, doc: body.doc, link: { medusa_id: "tx_applied" } })).toMatchObject({ action: "skip" })
        }
        const wallet = ok(await client.get(`/api/resource/${enc(WALLET_DOCTYPE)}/${enc(walletName)}`), "read Wallet")
        expect(planWalletStatus(webhookBody("on_update", WALLET_DOCTYPE, wallet).body.doc)).toMatchObject({ action: "unfreeze", customer, wallet: walletName, medusa_id: `wal_${stamp}` })
        expect(compareBalances({ medusa_main_minor: majorToMinor(wallet.balance_available), erpnext_available_minor: majorToMinor(wallet.balance_available), pending_outbound_minor: 0 }).state).toBe("equal")
    })

    it("draws on the Loan and repays it through the app's methods; the Loan webhook announces the change", async () => {
        const walletBefore = majorToMinor(ok(await client.get(`/api/resource/${enc(WALLET_DOCTYPE)}/${enc(walletName)}`), "read Wallet").balance_available)
        let credit = ok(await client.post(`/api/method/customer_wallet.api.credit.get_credit`, { customer }), "get_credit")
        if (!credit) {
            credit = ok(await client.post(`/api/method/customer_wallet.api.credit.open_credit_line`, { customer, limit: 5000, medusa_id: `cus_${stamp}`, origin: "Medusa" }), "open_credit_line")
            const loan = credit.name
            cleanup.push({
                what: `cancel and delete the Loan ${loan} this rehearsal opened`,
                run: async () => {
                    ok(await client.post(`/api/method/frappe.client.cancel`, { doctype: LOAN_DOCTYPE, name: loan }), "cancel Loan")
                    ok(await client.delete(`/api/resource/${enc(LOAN_DOCTYPE)}/${enc(loan)}`), "delete Loan")
                },
            })
        }
        const loanDoc = ok(await client.get(`/api/resource/${enc(LOAN_DOCTYPE)}/${enc(credit.name)}`), "read Loan")
        const announce = planLoan(webhookBody("on_update", LOAN_DOCTYPE, loanDoc).body.doc)
        expect(announce).toMatchObject({ action: "announce", customer, loan: credit.name })
        const availableBefore = majorToMinor(credit.available_limit_amount)
        expect(availableBefore).toBeGreaterThanOrEqual(120_000)

        const drawn = ok(await client.post(`/api/method/customer_wallet.api.credit.draw`, { customer, amount: 1200, idempotency_key: `wlc_${stamp}:credit`, medusa_id: `wlc_${stamp}:credit:draw`, origin: "Medusa" }), "draw")
        const ld = drawn.loan_disbursement.name
        // Should an expectation below fail, the draw is still repaid from the wallet it landed in, so the line is not left used up.
        let repaid = false
        cleanup.push({
            what: `repay the draw ${ld} after a failure`,
            run: async () => {
                if (repaid) return
                ok(await client.post(`/api/method/customer_wallet.api.credit.repay_from_wallet`, { customer, amount: 1200, idempotency_key: `wlc_${stamp}:credit:cleanup`, medusa_id: `wlc_${stamp}:credit:cleanup`, origin: "Medusa", loan_disbursement: ld }), "repay after a failure")
            },
        })
        expect(drawn.replayed).toBe(false)
        expect(majorToMinor(drawn.credit.available_limit_amount)).toBe(availableBefore - 120_000)
        const replay = ok(await client.post(`/api/method/customer_wallet.api.credit.draw`, { customer, amount: 1200, idempotency_key: `wlc_${stamp}:credit`, medusa_id: `wlc_${stamp}:credit:draw`, origin: "Medusa" }), "draw again")
        expect(replay.replayed).toBe(true)
        expect(replay.loan_disbursement.name).toBe(ld)

        // The draw's own wallet row is ERPNext's (origin Medusa, paired by medusa_id): the push must not send it, the webhook does not fire for it.
        const [drawRow] = await listWt(client, [["medusa_id", "=", `wlc_${stamp}:credit:draw`]])
        expect(drawRow).toMatchObject({ txn_type: "Deposit", origin: "Medusa" })
        const mirror: MedusaWalletRow = { id: "wtx_mirror", wallet_id: `wal_${stamp}`, customer_id: `cus_${stamp}`, direction: "credit", amount_minor: 120_000, kind: "grant_credit", bucket: "main", idempotency_key: `wlc_${stamp}:credit:draw`, metadata: { source: "credit_line_draw" } }
        expect(planOutboundWalletRow({ row: mirror, customer, company, link: null, paired: true, bank_account: null, posting_date: "2026-09-27" })).toMatchObject({ action: "skip" })

        const repayment = ok(await client.post(`/api/method/customer_wallet.api.credit.repay_from_wallet`, { customer, amount: 1200, idempotency_key: `wlc_${stamp}:credit:cancel`, medusa_id: `wlc_${stamp}:credit:cancel`, origin: "Medusa", loan_disbursement: ld }), "repay")
        repaid = true
        expect(repayment.replayed).toBe(false)
        expect(repayment.loan_repayments).toHaveLength(1)
        expect(majorToMinor(repayment.credit.available_limit_amount)).toBe(availableBefore)
        expect(ok(await client.post(`/api/method/customer_wallet.api.credit.repay_from_wallet`, { customer, amount: 1200, idempotency_key: `wlc_${stamp}:credit:cancel`, medusa_id: `wlc_${stamp}:credit:cancel`, origin: "Medusa" }), "repay again").replayed).toBe(true)

        // Both ledgers end where they began: the draw went into the wallet, the repayment came out of it.
        expect(majorToMinor(ok(await client.get(`/api/resource/${enc(WALLET_DOCTYPE)}/${enc(walletName)}`), "read Wallet").balance_available)).toBe(walletBefore)
        expect(majorToMinor(ok(await client.post(`/api/method/customer_wallet.api.credit.get_credit`, { customer }), "get_credit again").available_limit_amount)).toBe(availableBefore)
    })
})
