import { describe, expect, it } from "vitest"
import { deliveryNoteOf, planDeliveryFulfilment, salesOrdersOf } from "../delivery"

describe("a Delivery Note's ledger entry", () => {
    it("names the note, and says when it reverses one", () => {
        expect(deliveryNoteOf({ voucher_type: "Delivery Note", voucher_no: "MAT-DN-2026-00001", is_cancelled: 0 })).toEqual({ name: "MAT-DN-2026-00001", cancelled: false })
        expect(deliveryNoteOf({ voucher_type: "Delivery Note", voucher_no: "MAT-DN-2026-00001", is_cancelled: 1 })).toEqual({ name: "MAT-DN-2026-00001", cancelled: true })
        expect(deliveryNoteOf({ voucher_type: "Stock Entry", voucher_no: "MAT-STE-00001" })).toBeNull()
    })
})

describe("which order lines a Delivery Note fulfils", () => {
    const lines = [
        { id: "ordli_1", code: "ZZ-1", quantity: 2, fulfilled: 0 },
        { id: "ordli_2", code: "ZZ-2", quantity: 3, fulfilled: 1 },
        { id: "ordli_3", code: "ZZ-1", quantity: 1, fulfilled: 0 },
    ]

    it("takes the note's rows for this Sales Order, line by line, up to what is left", () => {
        const plan = planDeliveryFulfilment({
            salesOrder: "SAL-ORD-2026-00001",
            lines,
            dnItems: [
                { item_code: "ZZ-1", qty: 3, against_sales_order: "SAL-ORD-2026-00001" },
                { item_code: "ZZ-2", qty: 2, against_sales_order: "SAL-ORD-2026-00001" },
                { item_code: "ZZ-2", qty: 5, against_sales_order: "SAL-ORD-2026-00009" },
            ],
        })
        expect(plan.items).toEqual([
            { id: "ordli_1", quantity: 2 },
            { id: "ordli_3", quantity: 1 },
            { id: "ordli_2", quantity: 2 },
        ])
        expect(plan.unmatched).toEqual([])
    })

    it("reports quantity the order cannot take", () => {
        const plan = planDeliveryFulfilment({ salesOrder: "SO-1", lines, dnItems: [{ item_code: "ZZ-2", qty: 4, against_sales_order: "SO-1" }, { item_code: "ZZ-9", qty: 1, against_sales_order: "SO-1" }] })
        expect(plan.items).toEqual([{ id: "ordli_2", quantity: 2 }])
        expect(plan.unmatched).toEqual(["ZZ-2 × 2", "ZZ-9 × 1"])
    })

    it("lists the Sales Orders a note draws on", () => {
        expect(salesOrdersOf([{ against_sales_order: "A" }, { against_sales_order: "B" }, { against_sales_order: "A" }, {}])).toEqual(["A", "B"])
    })
})
