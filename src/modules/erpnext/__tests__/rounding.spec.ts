import { describe, expect, it } from "vitest"
import { ROUNDING_REFERENCE, planCartRounding } from "../rounding"

const cart = (over: Record<string, any> = {}) => ({
    currency_code: "inr",
    shipping_address: { province: "Karnataka" },
    items: [
        { unit_price: 800, quantity: 1, tax_lines: [{ rate: 2.5 }, { rate: 2.5 }] },
        { unit_price: 200, quantity: 1, tax_lines: [{ rate: 9 }, { rate: 9 }] },
    ],
    shipping_methods: [{ amount: 100 }],
    // Medusa's own total: 1000 + 100 + 76 + shipping's GST at the weighted 7.6%
    total: 1183.6,
    credit_lines: [],
    ...over,
})

describe("the cart's rounding line", () => {
    it("brings the total to ERPNext's rounded total", () => {
        const plan = planCartRounding({ cart: cart(), companyState: "29", roundTotal: true })
        expect(plan).toMatchObject({ action: "set", amount: -0.4, interState: false })
        if (plan.action === "set") expect(plan.estimate.payable).toBe(1184)
    })

    it("takes the fraction of a paisa a shipping share's tax leaves, so the total is exactly ERPNext's", () => {
        // Production order #10: Medusa's total before rounding was 7140.440306772.
        const plan = planCartRounding({ cart: cart({ total: 1183.600306772 }), companyState: "29", roundTotal: true })
        expect(plan).toMatchObject({ action: "set" })
        if (plan.action === "set") expect(1183.600306772 - plan.amount).toBeCloseTo(1184, 9)
    })

    it("works from the total before its own line, so it is stable on a second run", () => {
        const plan = planCartRounding({
            cart: cart({ total: 1184, credit_lines: [{ reference: ROUNDING_REFERENCE, amount: -0.4 }] }),
            companyState: "29",
            roundTotal: true,
        })
        expect(plan).toMatchObject({ action: "set", amount: -0.4 })
    })

    it("uses the billing state for the place of supply", () => {
        const plan = planCartRounding({ cart: cart({ billing_address: { province: "Maharashtra" } }), companyState: "29", roundTotal: true })
        expect(plan).toMatchObject({ action: "set", interState: true })
    })

    it("clears the line when ERPNext does not round, or before tax exists", () => {
        expect(planCartRounding({ cart: cart(), companyState: "29", roundTotal: false })).toMatchObject({ action: "clear" })
        expect(planCartRounding({ cart: cart({ shipping_address: null }), companyState: "29", roundTotal: true })).toMatchObject({ action: "clear" })
        expect(planCartRounding({ cart: cart({ items: [{ unit_price: 10, quantity: 1, tax_lines: [] }] }), companyState: "29", roundTotal: true })).toMatchObject({ action: "clear" })
    })

    it("refuses to paper over a real disagreement, and clears its line", () => {
        expect(planCartRounding({ cart: cart({ total: 1300 }), companyState: "29", roundTotal: true })).toMatchObject({ action: "clear" })
    })

    it("leaves other credit lines to come off the rounded total", () => {
        // A ₹500 gift card: Medusa's total is 1183.60 - 500 = 683.60, and the buyer owes 1184 - 500.
        const plan = planCartRounding({ cart: cart({ total: 683.6, credit_lines: [{ reference: "gift-card", amount: 500 }] }), companyState: "29", roundTotal: true })
        expect(plan).toMatchObject({ action: "set", amount: -0.4 })
    })

    it("follows the site's rounding method and the currency's smallest fraction", () => {
        const half = cart({ items: [{ unit_price: 1000.5, quantity: 1, tax_lines: [{ rate: 0 }] }], shipping_methods: [], total: 1000.5 })
        expect(planCartRounding({ cart: half, companyState: "29", roundTotal: true })).toMatchObject({ amount: 0.5 })
        expect(planCartRounding({ cart: half, companyState: "29", roundTotal: true, rounding: { method: "Commercial Rounding" } })).toMatchObject({ amount: -0.5 })
        expect(planCartRounding({ cart: cart(), companyState: "29", roundTotal: true, rounding: { smallestFraction: 0.05 } })).toMatchObject({ amount: 0 })
    })
})
