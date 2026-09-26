import { describe, expect, it } from "vitest"
import {
    isStockOrPriceDoctype,
    itemPriceCondition,
    planItemPrice,
    safetyFor,
    sellableQty,
    stockLedgerCondition,
    stockPairsOf,
} from "../stock-prices"

describe("sellableQty", () => {
    it("is on hand less reserved less the buffer, never negative", () => {
        expect(sellableQty({ actual_qty: 10, reserved_qty: 3 }, 2)).toBe(5)
        expect(sellableQty({ actual_qty: 4, reserved_qty: 6 }, 0)).toBe(0)
        expect(sellableQty({ actual_qty: "7.5", reserved_qty: "2.5" }, "-1")).toBe(5)
        expect(sellableQty(null, 3)).toBe(0)
    })
    it("takes the Item's own safety stock when set, else the store's", () => {
        expect(safetyFor(4, 10)).toBe(4)
        expect(safetyFor(0, 10)).toBe(10)
        expect(safetyFor(null, "2")).toBe(2)
        expect(safetyFor(undefined, -5)).toBe(0)
    })
})

describe("stockPairsOf", () => {
    it("takes a ledger entry at the store's warehouse only", () => {
        expect(stockPairsOf({ doctype: "Stock Ledger Entry", doc: { item_code: "A", warehouse: "Stores - F" } }, "Stores - F")).toEqual([
            { item_code: "A", warehouse: "Stores - F" },
        ])
        expect(stockPairsOf({ doctype: "Stock Ledger Entry", doc: { item_code: "A", warehouse: "Other - F" } }, "Stores - F")).toEqual([])
        expect(stockPairsOf({ doctype: "Stock Ledger Entry", doc: { item_code: "A", warehouse: "Stores - F" } }, "")).toEqual([])
    })
    it("takes each item a Sales Order reserves at the warehouse, once", () => {
        const body = {
            doctype: "Sales Order",
            doc: {
                items: [
                    { item_code: "A", warehouse: "Stores - F" },
                    { item_code: "A", warehouse: "Stores - F" },
                    { item_code: "B", warehouse: "Other - F" },
                    { item_code: "C", warehouse: "Stores - F" },
                ],
            },
        }
        expect(stockPairsOf(body, "Stores - F").map((p) => p.item_code)).toEqual(["A", "C"])
    })
    it("knows which doctypes it handles", () => {
        expect(isStockOrPriceDoctype("Item Price")).toBe(true)
        expect(isStockOrPriceDoctype("Sales Order")).toBe(true)
        expect(isStockOrPriceDoctype("Item")).toBe(false)
        expect(stockPairsOf({ doctype: "Item", doc: {} }, "Stores - F")).toEqual([])
    })
})

describe("planItemPrice", () => {
    const today = "2026-09-27"
    const doc = { item_code: "A", price_list: "Standard Selling", currency: "INR", price_list_rate: 1499, selling: 1 }
    it("sets the base price for a selling price on the store's list", () => {
        expect(planItemPrice({ event: "on_update", doc, priceList: "Standard Selling", today })).toEqual({
            action: "set",
            item_code: "A",
            currency: "inr",
            amount: 1499,
        })
    })
    it("removes it on trash", () => {
        expect(planItemPrice({ event: "on_trash", doc, priceList: "Standard Selling", today })).toEqual({ action: "remove", item_code: "A", currency: "inr" })
    })
    it("leaves other lists, tiers, customer prices, buying prices and dated prices alone", () => {
        const skip = (d: any, list = "Standard Selling") => planItemPrice({ event: "on_update", doc: d, priceList: list, today })
        expect(skip({ ...doc, price_list: "Wholesale" })).toMatchObject({ action: "skip" })
        expect(skip(doc, "")).toMatchObject({ action: "skip", reason: "no selling price list configured" })
        expect(skip({ ...doc, packing_unit: 12 })).toMatchObject({ action: "skip" })
        expect(skip({ ...doc, customer: "CRN-1" })).toMatchObject({ action: "skip" })
        expect(skip({ ...doc, selling: 0 })).toMatchObject({ action: "skip", reason: "not a selling price" })
        expect(skip({ ...doc, valid_upto: "2026-09-26" })).toMatchObject({ action: "skip", reason: "expired on 2026-09-26" })
        expect(skip({ ...doc, valid_from: "2026-10-01" })).toMatchObject({ action: "skip" })
        expect(skip({ ...doc, price_list_rate: "n/a" })).toMatchObject({ action: "skip" })
        expect(skip({ ...doc, valid_from: "2026-09-01", valid_upto: "2026-12-31" })).toMatchObject({ action: "set" })
    })
})

describe("webhook conditions", () => {
    it("quote the names as Python strings", () => {
        expect(stockLedgerCondition('Stores - "F"')).toBe('doc.warehouse == "Stores - \\"F\\""')
        expect(itemPriceCondition("Standard Selling")).toBe('doc.price_list == "Standard Selling" and doc.selling == 1')
    })
})
