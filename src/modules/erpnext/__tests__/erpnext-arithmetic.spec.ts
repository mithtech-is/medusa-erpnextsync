import { describe, expect, it } from "vitest"
import { estimateSalesTotals, frappeRound } from "../erpnext-arithmetic"

describe("Frappe's banker's rounding", () => {
    it("rounds halves to even and everything else to nearest", () => {
        expect(frappeRound(2226.5, 0)).toBe(2226)
        expect(frappeRound(2227.5, 0)).toBe(2228)
        expect(frappeRound(1183.6, 0)).toBe(1184)
        expect(frappeRound(1183.4, 0)).toBe(1183)
        expect(frappeRound(169.8138, 2)).toBe(169.81)
        expect(frappeRound(-2.5, 0)).toBe(-2)
        expect(frappeRound(0, 2)).toBe(0)
    })
    it("treats a decimal half that binary cannot hold exactly as a half", () => {
        // 1.005 is 1.00499999999999989... in binary; Frappe still calls it a tie.
        expect(frappeRound(1.005, 2)).toBe(1)
        expect(frappeRound(1.015, 2)).toBe(1.02)
        expect(frappeRound(123.455, 2)).toBe(123.46)
    })
})

describe("ERPNext's totals for a store order", () => {
    const lines = [
        { rate: 800, qty: 1, gstRate: 5 },
        { rate: 200, qty: 1, gstRate: 18 },
    ]

    it("spreads shipping by line value and taxes each share at the line's rate (production trial, 2026-09-28)", () => {
        const out = estimateSalesTotals({ lines, shipping: 100, interState: false, roundTotal: true })
        expect(out.taxes).toEqual([100, 41.8, 41.8])
        expect(out.gstTotal).toBe(83.6)
        expect(out.grandTotal).toBe(1183.6)
        expect(out.payable).toBe(1184)
        expect(out.roundingAdjustment).toBe(0.4)
    })

    it("taxes the lines alone without shipping", () => {
        const out = estimateSalesTotals({ lines, shipping: 0, interState: false, roundTotal: true })
        expect(out.taxes).toEqual([38, 38])
        expect(out.grandTotal).toBe(1076)
    })

    it("taxes a discounted line on its net amount", () => {
        const out = estimateSalesTotals({ lines: [{ rate: 720, qty: 1, gstRate: 5 }, { rate: 180, qty: 1, gstRate: 18 }], shipping: 100, interState: false, roundTotal: true })
        expect(out.netTotal).toBe(900)
        expect(out.gstTotal).toBe(76)
        expect(out.grandTotal).toBe(1076)
    })

    it("rounds CGST and SGST separately in-state, one IGST row out of state (production trial, 2026-09-28)", () => {
        const one = [{ rate: 1886.82, qty: 1, gstRate: 18 }]
        const inState = estimateSalesTotals({ lines: one, shipping: 0, interState: false, roundTotal: true })
        expect(inState.taxes).toEqual([169.81, 169.81])
        expect(inState.grandTotal).toBe(2226.44)
        const outState = estimateSalesTotals({ lines: one, shipping: 0, interState: true, roundTotal: true })
        expect(outState.taxes).toEqual([339.63])
        expect(outState.grandTotal).toBe(2226.45)
        expect(outState.payable).toBe(2226)
    })

    it("leaves the grand total alone when ERPNext does not round", () => {
        const out = estimateSalesTotals({ lines, shipping: 100, interState: false, roundTotal: false })
        expect(out.payable).toBe(1183.6)
        expect(out.roundingAdjustment).toBe(0)
    })
})
