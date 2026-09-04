import { describe, expect, it } from "vitest"

import {
    PAYMENTS_KEY,
    TOTAL_KEY,
    mergeReceipt,
    receiptFrom,
    receiptsOf,
    totalReceived,
} from "../order-payments"

const wire = (over: Record<string, any> = {}) => ({
    medusa_order_id: "order_1",
    payment_entry: "PE-1",
    method: "Bank Draft",
    reference: "NEFT-991",
    amount: 250,
    currency: "INR",
    received_at: "2026-09-04",
    status: "received",
    against: { doctype: "Sales Order", name: "SO-11" },
    ...over,
})

describe("reading a receipt off the wire", () => {
    it("keeps the Payment Entry that produced it", () => {
        expect(receiptFrom(wire())?.payment_entry).toBe("PE-1")
    })

    it("refuses a payload it could not file", () => {
        // Without the Payment Entry name there is nowhere to put it, and a
        // generated key would duplicate the receipt on every retry.
        expect(receiptFrom(wire({ payment_entry: "" }))).toBeNull()
        expect(receiptFrom({})).toBeNull()
    })

    it("treats a missing amount as nothing received, not as NaN", () => {
        expect(receiptFrom(wire({ amount: undefined }))?.amount).toBe(0)
        expect(receiptFrom(wire({ amount: "not a number" }))?.amount).toBe(0)
    })

    it("reads an amount that arrived as a string", () => {
        expect(receiptFrom(wire({ amount: "250.50" }))?.amount).toBe(250.5)
    })
})

describe("filing receipts against an order", () => {
    it("does not erase the receipt that came before", () => {
        const first = mergeReceipt({}, receiptFrom(wire())!)
        const second = mergeReceipt(first, receiptFrom(wire({ payment_entry: "PE-2", amount: 100 }))!)
        expect(Object.keys(receiptsOf(second)).sort()).toEqual(["PE-1", "PE-2"])
        expect(second[TOTAL_KEY]).toBe(350)
    })

    it("lets the same Payment Entry arrive twice without counting twice", () => {
        const once = mergeReceipt({}, receiptFrom(wire())!)
        const twice = mergeReceipt(once, receiptFrom(wire())!)
        expect(Object.keys(receiptsOf(twice))).toEqual(["PE-1"])
        expect(twice[TOTAL_KEY]).toBe(250)
    })

    it("lets a correction replace what that Payment Entry said before", () => {
        const before = mergeReceipt({}, receiptFrom(wire({ amount: 250 }))!)
        const after = mergeReceipt(before, receiptFrom(wire({ amount: 275 }))!)
        expect(receiptsOf(after)["PE-1"].amount).toBe(275)
        expect(after[TOTAL_KEY]).toBe(275)
    })

    it("keeps a cancelled receipt on the record but out of the total", () => {
        // Somebody will ask where the money went. Deleting the row would
        // leave the order looking as though it was never paid at all.
        const paid = mergeReceipt({}, receiptFrom(wire())!)
        const reversed = mergeReceipt(paid, receiptFrom(wire({ status: "cancelled" }))!)
        expect(receiptsOf(reversed)["PE-1"].status).toBe("cancelled")
        expect(reversed[TOTAL_KEY]).toBe(0)
    })

    it("leaves every other metadata key alone", () => {
        const existing = { tracking: { awb: "123" }, erp_fulfillment: { status: "dispatched" } }
        const merged = mergeReceipt(existing, receiptFrom(wire())!)
        expect(merged.tracking).toEqual({ awb: "123" })
        expect(merged.erp_fulfillment).toEqual({ status: "dispatched" })
        expect(merged[PAYMENTS_KEY]["PE-1"].reference).toBe("NEFT-991")
    })

    it("copes with an order that has no metadata at all", () => {
        expect(mergeReceipt(null, receiptFrom(wire())!)[TOTAL_KEY]).toBe(250)
        expect(mergeReceipt(undefined, receiptFrom(wire())!)[TOTAL_KEY]).toBe(250)
    })

    it("ignores a metadata key of the right name but the wrong shape", () => {
        // Someone (or an older version) may have written a string or an
        // array there. Reading it as a map of receipts must not throw.
        expect(receiptsOf({ [PAYMENTS_KEY]: "nonsense" })).toEqual({})
        expect(receiptsOf({ [PAYMENTS_KEY]: ["nonsense"] })).toEqual({})
        expect(mergeReceipt({ [PAYMENTS_KEY]: "nonsense" }, receiptFrom(wire())!)[TOTAL_KEY]).toBe(250)
    })

    it("adds currency amounts without a floating-point tail", () => {
        let meta = mergeReceipt({}, receiptFrom(wire({ payment_entry: "PE-1", amount: 0.1 }))!)
        meta = mergeReceipt(meta, receiptFrom(wire({ payment_entry: "PE-2", amount: 0.2 }))!)
        expect(totalReceived(meta)).toBe(0.3)
    })
})
