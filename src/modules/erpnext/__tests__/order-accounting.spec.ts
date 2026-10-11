import { describe, expect, it } from "vitest"

import {
    CANCEL_ORDER,
    DEFAULT_PAYMENT_MODES,
    cancelStep,
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
            paid_to: "Cashfree Clearing - SGPL",
            paid_amount: 1180,
            references: [{ name: "row-1", parent: "new-payment-entry-1", reference_doctype: "Sales Invoice", reference_name: "SINV-1", allocated_amount: 1180 }],
        }
        const doc = preparePaymentEntry(pe, { mode: "Cashfree", reference: "5114910293", referenceDate: "2026-10-11" })
        expect(doc).toEqual({
            payment_type: "Receive",
            paid_to: "Cashfree Clearing - SGPL",
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
