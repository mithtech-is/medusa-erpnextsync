import { describe, expect, it } from "vitest"

import type { FrappeClient, FrappeResult } from "../frappe-client"
import {
    CANCEL_ORDER,
    bookBeforeCancel,
    DEFAULT_PAYMENT_MODES,
    cancelStep,
    createPaymentEntry,
    findPaymentEntry,
    submitDocument,
    submitStep,
    unwindDocument,
    isCashOnDelivery,
    mappingHandlesEvent,
    normalizePaymentModes,
    paymentAmount,
    planOrderAccounting,
    preparePaymentEntry,
    providersOf,
    refundState,
    transactionReference,
} from "../order-accounting"

const modes = { "pp_cashfree-pg": "Cashfree" }
const paid = (over: Record<string, any> = {}) => ({
    id: "order_1",
    total: 1180,
    payment_providers: ["pp_cashfree-pg"],
    payments: [{ id: "pay_1", amount: 1180, provider_id: "pp_cashfree-pg", captured_at: "2026-10-11T06:00:00Z", reference: "5114910293" }],
    ...over,
})

describe("the provider → Mode of Payment map", () => {
    it("defaults to Cashfree when Settings has none", () => {
        expect(normalizePaymentModes(null)).toEqual({ "pp_cashfree-pg": "Cashfree" })
        expect(normalizePaymentModes(undefined)).toEqual(DEFAULT_PAYMENT_MODES)
    })

    it("keeps an explicit map, trimmed, and drops blank pairs", () => {
        expect(normalizePaymentModes({ " pp_razorpay_razorpay ": " Razorpay ", pp_x: "", "": "Cash" })).toEqual({
            pp_razorpay_razorpay: "Razorpay",
        })
        expect(normalizePaymentModes({})).toEqual({})
        expect(normalizePaymentModes('{"pp_a":"Bank"}')).toEqual({ pp_a: "Bank" })
        expect(normalizePaymentModes(["pp_a"])).toEqual({})
    })
})

describe("which documents an order's state asks for", () => {
    it("does nothing while payments are not recorded", () => {
        expect(planOrderAccounting({ recordPayments: false, order: paid(), fullyPaid: true, modes }).action).toBe("none")
    })

    it("an online order captured in full: submit the order and invoice and book each payment to its mode", () => {
        const plan = planOrderAccounting({ recordPayments: true, order: paid(), fullyPaid: true, modes })
        expect(plan).toEqual({
            action: "record-payments",
            payments: [expect.objectContaining({ id: "pay_1", amount: 1180, mode: "Cashfree" })],
        })
    })

    it("an online order not yet captured stays a draft", () => {
        const placed = paid({ payments: [] })
        expect(planOrderAccounting({ recordPayments: true, order: placed, fullyPaid: false, modes }).action).toBe("none")
        expect(planOrderAccounting({ recordPayments: true, order: paid(), fullyPaid: false, modes }).action).toBe("none")
    })

    it("cash on delivery: submit the Sales Order when placed, and never book a payment", () => {
        const cod = { id: "order_2", total: 500, payment_providers: ["pp_cod"], payments: [] }
        expect(planOrderAccounting({ recordPayments: true, order: cod, fullyPaid: false, modes }).action).toBe("submit-order")
        const collected = { ...cod, payments: [{ id: "pay_2", amount: 500, provider_id: "pp_cod" }] }
        expect(planOrderAccounting({ recordPayments: true, order: collected, fullyPaid: true, modes }).action).toBe("submit-order")
    })

    it("refuses to guess a mode for a provider nobody mapped", () => {
        const plan = planOrderAccounting({
            recordPayments: true,
            order: paid({ payments: [{ id: "pay_3", amount: 1180, provider_id: "pp_system_default" }] }),
            fullyPaid: true,
            modes,
        })
        expect(plan.action).toBe("fail")
        expect((plan as any).error).toContain("pp_system_default")
    })
})

describe("payment providers", () => {
    it("knows cash on delivery by Medusa's provider id", () => {
        expect(isCashOnDelivery("pp_cod")).toBe(true)
        expect(isCashOnDelivery("pp_cod_cod")).toBe(true)
        expect(isCashOnDelivery("pp_cashfree-pg")).toBe(false)
        expect(isCashOnDelivery("pp_codex")).toBe(false)
        expect(isCashOnDelivery(null)).toBe(false)
    })

    it("lists an order's providers once, from its payments and what the registry found", () => {
        expect(providersOf({ payment_providers: ["pp_cod"], payments: [{ provider_id: "pp_cod" }, { provider_id: "pp_x" }] })).toEqual([
            "pp_cod",
            "pp_x",
        ])
        expect(providersOf({})).toEqual([])
    })

    it("takes the gateway's own payment id as the reference", () => {
        expect(transactionReference({ order_id: "medusa-1", cf_payment_id: 5114910293 })).toBe("5114910293")
        expect(transactionReference({ transaction_id: " T-9 " })).toBe("T-9")
        expect(transactionReference({ order_id: "medusa-1" })).toBeNull()
        expect(transactionReference(null)).toBeNull()
    })
})

describe("how much a Payment Entry settles", () => {
    it("lets ERPNext's own figure stand when the payment matches what is outstanding", () => {
        expect(paymentAmount(1180, 1180)).toEqual({ ok: true, partyAmount: null })
        expect(paymentAmount(1180, 1180.01)).toEqual({ ok: true, partyAmount: null })
    })

    it("books less than outstanding as a part payment", () => {
        expect(paymentAmount(500, 1180)).toEqual({ ok: true, partyAmount: 500, note: "part payment: 680.00 still outstanding" })
    })

    it("makes nothing for an invoice already settled, and refuses to overpay one", () => {
        expect(paymentAmount(1180, 0)).toEqual({ ok: true, skip: "the invoice has nothing outstanding" })
        expect(paymentAmount(1200, 1180)).toMatchObject({ ok: false })
        expect(paymentAmount(0, 1180)).toMatchObject({ ok: false })
    })
})

describe("the Payment Entry sent to ERPNext", () => {
    it("is ERPNext's own document with the store's mode and reference, and nothing that would make it an update", () => {
        const pe = {
            name: "new-payment-entry-1",
            __islocal: 1,
            docstatus: 0,
            payment_type: "Receive",
            paid_to: "Cashfree Clearing - EC",
            paid_amount: 1180,
            references: [{ name: "row-1", parent: "new-payment-entry-1", reference_doctype: "Sales Invoice", reference_name: "SINV-1", allocated_amount: 1180 }],
        }
        const doc = preparePaymentEntry(pe, { mode: "Cashfree", reference: "5114910293", referenceDate: "2026-10-11" })
        expect(doc).toEqual({
            payment_type: "Receive",
            paid_to: "Cashfree Clearing - EC",
            paid_amount: 1180,
            mode_of_payment: "Cashfree",
            reference_no: "5114910293",
            reference_date: "2026-10-11",
            references: [{ reference_doctype: "Sales Invoice", reference_name: "SINV-1", allocated_amount: 1180 }],
        })
        expect(pe.name).toBe("new-payment-entry-1")
    })
})

describe("cancelling an order's documents", () => {
    it("goes Payment Entry, then invoice, then order", () => {
        expect(CANCEL_ORDER.map((s) => s.doctype)).toEqual(["Payment Entry", "Sales Invoice", "Sales Order"])
    })

    it("deletes a draft, cancels a submitted document and leaves a cancelled one alone", () => {
        expect(cancelStep(0)).toBe("delete")
        expect(cancelStep("1")).toBe("cancel")
        expect(cancelStep(2)).toBe("none")
    })
})

describe("refunds", () => {
    const pay = (amount: number, refunded: number) => ({ id: `p${amount}${refunded}`, amount, refunded })

    it("is full only when every captured payment went back in full", () => {
        expect(refundState([pay(1180, 1180)])).toBe("full")
        expect(refundState([pay(1180, 1179.995)])).toBe("full")
        expect(refundState([pay(1180, 1180), pay(200, 0)])).toBe("partial")
        expect(refundState([pay(1180, 500)])).toBe("partial")
        expect(refundState([pay(1180, 0)])).toBe("none")
        expect(refundState([])).toBe("none")
    })

    it("reach the mappings that cancel orders", () => {
        expect(mappingHandlesEvent(["order.placed", "order.canceled"], "order.payment_refunded")).toBe(true)
        expect(mappingHandlesEvent(["order.placed"], "order.payment_refunded")).toBe(false)
        expect(mappingHandlesEvent(["order.placed"], "order.placed")).toBe(true)
        expect(mappingHandlesEvent(null, "order.placed")).toBe(false)
    })
})

type Call = { method: string; path: string; body?: any; query?: Record<string, string> }

/** A fake ERPNext: answers by method and path, and remembers every call. */
function fakeErpnext(answers: Record<string, FrappeResult | ((body: any) => FrappeResult)>) {
    const calls: Call[] = []
    const answer = (method: string, path: string, body?: any): FrappeResult => {
        const a = answers[`${method} ${path}`]
        if (typeof a === "function") return a(body)
        return a ?? { ok: false, status: 404, error: "HTTP 404: not found" }
    }
    const client: FrappeClient = {
        async get(path, query) {
            calls.push({ method: "GET", path, query })
            return answer("GET", path)
        },
        async post(path, body) {
            calls.push({ method: "POST", path, body })
            return answer("POST", path, body)
        },
        async put(path, body) {
            calls.push({ method: "PUT", path, body })
            return answer("PUT", path, body)
        },
        async delete(path) {
            calls.push({ method: "DELETE", path })
            return answer("DELETE", path)
        },
    }
    const writes = () => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)
    return { client, calls, writes }
}

const ok = (data: any): FrappeResult => ({ ok: true, status: 200, data })
const refused = (error: string): FrappeResult => ({ ok: false, status: 417, error })

describe("submitting a store document", () => {
    it("submits a draft once, by saving it with docstatus 1", async () => {
        const erp = fakeErpnext({
            "GET /api/resource/Sales%20Order/SO-1": ok({ name: "SO-1", docstatus: 0 }),
            "PUT /api/resource/Sales%20Order/SO-1": ok({ name: "SO-1", docstatus: 1 }),
        })
        expect(await submitDocument(erp.client, "Sales Order", "SO-1")).toEqual({ ok: true, state: "submitted" })
        expect(erp.calls.find((c) => c.method === "PUT")?.body).toEqual({ docstatus: 1 })
    })

    it("never submits twice, and never revives a cancelled document", async () => {
        const erp = fakeErpnext({
            "GET /api/resource/Sales%20Invoice/SI-1": ok({ docstatus: 1 }),
            "GET /api/resource/Sales%20Invoice/SI-2": ok({ docstatus: 2 }),
        })
        expect(await submitDocument(erp.client, "Sales Invoice", "SI-1")).toEqual({ ok: true, state: "already" })
        expect(await submitDocument(erp.client, "Sales Invoice", "SI-2")).toEqual({ ok: true, state: "cancelled" })
        expect(erp.writes()).toEqual([])
        expect(submitStep(0)).toBe("submit")
        expect(submitStep(undefined)).toBe("submit")
    })

    it("passes on ERPNext's reason when it refuses, and leaves the draft", async () => {
        const erp = fakeErpnext({
            "GET /api/resource/Sales%20Order/SO-1": ok({ docstatus: 0 }),
            "PUT /api/resource/Sales%20Order/SO-1": refused("HTTP 417: Billing Address GSTIN is mandatory"),
        })
        expect(await submitDocument(erp.client, "Sales Order", "SO-1")).toEqual({
            ok: false,
            error: "HTTP 417: Billing Address GSTIN is mandatory",
            httpStatus: 417,
        })
        expect(erp.writes()).toEqual(["PUT /api/resource/Sales%20Order/SO-1"])
    })
})

describe("making a Payment Entry", () => {
    const invoice = ok({ name: "SINV-1", docstatus: 1, company: "Example Company", outstanding_amount: 1180, rounded_total: 1180 })
    const built = {
        doctype: "Payment Entry",
        payment_type: "Receive",
        party_type: "Customer",
        party: "CUST-1",
        paid_to: "Cashfree Clearing - EC",
        paid_amount: 1180,
        received_amount: 1180,
        references: [{ reference_doctype: "Sales Invoice", reference_name: "SINV-1", allocated_amount: 1180 }],
    }
    const args = { invoice: "SINV-1", captured: 1180, mode: "Cashfree", reference: "5114910293", referenceDate: "2026-10-11" }

    it("lets ERPNext build it into the mode's account, then saves it as a draft with the store's reference", async () => {
        const erp = fakeErpnext({
            "GET /api/resource/Sales%20Invoice/SINV-1": invoice,
            "POST /api/method/erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account": ok({ account: "Cashfree Clearing - EC" }),
            "POST /api/method/erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry": ok(built),
            "POST /api/resource/Payment%20Entry": (body) => ok({ ...body, name: "ACC-PAY-2026-00001", docstatus: 0 }),
        })
        expect(await createPaymentEntry(erp.client, args)).toEqual({ ok: true, name: "ACC-PAY-2026-00001" })
        const [account, build, insert] = erp.calls.filter((c) => c.method === "POST")
        expect(account.body).toEqual({ mode_of_payment: "Cashfree", company: "Example Company" })
        // No party_amount: ERPNext's outstanding amount, rounding included, settles the invoice.
        expect(build.body).toEqual({ dt: "Sales Invoice", dn: "SINV-1", bank_account: "Cashfree Clearing - EC" })
        expect(insert.body).toMatchObject({ mode_of_payment: "Cashfree", reference_no: "5114910293", reference_date: "2026-10-11", paid_amount: 1180 })
        expect(insert.body.docstatus).toBeUndefined()
    })

    it("books a smaller payment for what was captured", async () => {
        const erp = fakeErpnext({
            "GET /api/resource/Sales%20Invoice/SINV-1": invoice,
            "POST /api/method/erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account": ok({ account: "Cashfree Clearing - EC" }),
            "POST /api/method/erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry": ok(built),
            "POST /api/resource/Payment%20Entry": ok({ name: "ACC-PAY-2026-00002" }),
        })
        const out = await createPaymentEntry(erp.client, { ...args, captured: 500 })
        expect(out).toEqual({ ok: true, name: "ACC-PAY-2026-00002", note: "part payment: 680.00 still outstanding" })
        expect(erp.calls.find((c) => c.path.endsWith("get_payment_entry"))?.body.party_amount).toBe(500)
    })

    it("makes nothing for a settled invoice, and stops at a mode with no account", async () => {
        const settled = fakeErpnext({ "GET /api/resource/Sales%20Invoice/SINV-1": ok({ company: "C", outstanding_amount: 0 }) })
        expect(await createPaymentEntry(settled.client, args)).toEqual({ ok: true, skip: "the invoice has nothing outstanding" })
        expect(settled.writes()).toEqual([])

        const noAccount = fakeErpnext({
            "GET /api/resource/Sales%20Invoice/SINV-1": invoice,
            "POST /api/method/erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account": refused(
                "HTTP 417: Please set default Cash or Bank account in Mode of Payment Cashfree",
            ),
        })
        const out = await createPaymentEntry(noAccount.client, args)
        expect(out).toMatchObject({ ok: false })
        expect((out as any).error).toContain("Mode of Payment Cashfree")
        expect(noAccount.writes()).toEqual(["POST /api/method/erpnext.accounts.doctype.sales_invoice.sales_invoice.get_bank_cash_account"])
    })

    it("finds an entry an earlier attempt made for the same payment and invoice", async () => {
        const erp = fakeErpnext({ "GET /api/resource/Payment%20Entry": ok([{ name: "ACC-PAY-2026-00001" }]) })
        expect(await findPaymentEntry(erp.client, "SINV-1", "5114910293")).toBe("ACC-PAY-2026-00001")
        expect(JSON.parse(erp.calls[0].query!.filters)).toEqual([
            ["reference_no", "=", "5114910293"],
            ["docstatus", "<", 2],
            ["Payment Entry Reference", "reference_name", "=", "SINV-1"],
        ])
        expect(await findPaymentEntry(fakeErpnext({}).client, "SINV-1", "x")).toBeNull()
    })
})

describe("unwinding a document", () => {
    it("deletes a draft, cancels a submitted one, and tolerates one already cancelled or gone", async () => {
        const erp = fakeErpnext({
            "GET /api/resource/Sales%20Invoice/SI-D": ok({ docstatus: 0 }),
            "DELETE /api/resource/Sales%20Invoice/SI-D": ok(null),
            "GET /api/resource/Payment%20Entry/PE-1": ok({ docstatus: 1 }),
            "POST /api/method/frappe.client.cancel": ok({}),
            "GET /api/resource/Sales%20Order/SO-1": ok({ docstatus: 2 }),
        })
        expect(await unwindDocument(erp.client, "Sales Invoice", "SI-D")).toEqual({ ok: true, done: "deleted" })
        expect(await unwindDocument(erp.client, "Payment Entry", "PE-1")).toEqual({ ok: true, done: "cancelled" })
        expect(await unwindDocument(erp.client, "Sales Order", "SO-1")).toEqual({ ok: true, done: "already cancelled" })
        expect(await unwindDocument(erp.client, "Sales Order", "SO-GONE")).toEqual({ ok: true, done: "missing" })
        expect(erp.calls.find((c) => c.path === "/api/method/frappe.client.cancel")?.body).toEqual({ doctype: "Payment Entry", name: "PE-1" })
        expect(erp.writes()).toEqual(["DELETE /api/resource/Sales%20Invoice/SI-D", "POST /api/method/frappe.client.cancel"])
    })

    it("says why ERPNext would not cancel", async () => {
        const erp = fakeErpnext({
            "GET /api/resource/Sales%20Invoice/SI-1": ok({ docstatus: 1 }),
            "POST /api/method/frappe.client.cancel": refused("HTTP 417: Cannot cancel because submitted Payment Entry ACC-PAY-1 exists"),
        })
        expect(await unwindDocument(erp.client, "Sales Invoice", "SI-1")).toMatchObject({
            ok: false,
            error: "Sales Invoice SI-1 not cancelled: HTTP 417: Cannot cancel because submitted Payment Entry ACC-PAY-1 exists",
        })
    })
})

describe("a paid order cancelled before ERPNext had all of it", () => {
    const payments = [{ id: "pay_1", amount: 1180, provider_id: "pp_cashfree-pg" }]
    const all = { recordPayments: true, payments, hasSalesOrder: true, hasInvoice: true, bookedPaymentIds: ["pay_1"] }

    it("is booked first when a document or a Payment Entry is missing", () => {
        expect(bookBeforeCancel({ ...all, hasSalesOrder: false, hasInvoice: false, bookedPaymentIds: [] })).toBe(true)
        expect(bookBeforeCancel({ ...all, hasInvoice: false })).toBe(true)
        expect(bookBeforeCancel({ ...all, bookedPaymentIds: [] })).toBe(true)
    })

    it("goes straight to cancelling once everything is there, or when nothing was paid or recorded", () => {
        expect(bookBeforeCancel(all)).toBe(false)
        expect(bookBeforeCancel({ ...all, payments: [], hasSalesOrder: false })).toBe(false)
        expect(bookBeforeCancel({ ...all, recordPayments: false, hasSalesOrder: false })).toBe(false)
    })

    it("needs only the Sales Order for cash on delivery", () => {
        const cod = [{ id: "pay_2", amount: 500, provider_id: "pp_cod" }]
        expect(bookBeforeCancel({ ...all, payments: cod, hasSalesOrder: false, hasInvoice: false, bookedPaymentIds: [] })).toBe(true)
        expect(bookBeforeCancel({ ...all, payments: cod, hasInvoice: false, bookedPaymentIds: [] })).toBe(false)
    })
})
