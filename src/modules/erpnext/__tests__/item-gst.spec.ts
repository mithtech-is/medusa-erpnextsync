import { describe, expect, it } from "vitest"
import { effectiveItemTaxTemplate, planProductTaxRule, templateFromRows } from "../item-gst"

describe("the Item Tax Template ERPNext would pick", () => {
    const today = "2026-09-28"

    it("takes the Item's own undated row for a blank tax category", () => {
        expect(templateFromRows({ rows: [{ item_tax_template: "GST 5% - SGPL" }], today })).toBe("GST 5% - SGPL")
        expect(templateFromRows({ rows: [{ item_tax_template: "GST 5% - SGPL", tax_category: "Out-State" }], today })).toBeNull()
    })

    it("prefers the newest row whose date has come", () => {
        const rows = [
            { item_tax_template: "GST 12% - SGPL", valid_from: "2025-01-01" },
            { item_tax_template: "GST 18% - SGPL", valid_from: "2026-09-01" },
            { item_tax_template: "GST 28% - SGPL", valid_from: "2026-12-01" },
            { item_tax_template: "GST 5% - SGPL" },
        ]
        expect(templateFromRows({ rows, today })).toBe("GST 18% - SGPL")
    })

    it("ignores another company's templates", () => {
        const companyOf = (t: string) => (t.endsWith("SGPL") ? "SGPL" : "FIPL")
        expect(templateFromRows({ rows: [{ item_tax_template: "GST 5% - FIPL" }, { item_tax_template: "GST 12% - SGPL" }], today, company: "SGPL", companyOf })).toBe("GST 12% - SGPL")
    })

    it("falls back to the Item's group, then the group's parents", () => {
        expect(effectiveItemTaxTemplate({ tables: [[], null, [{ item_tax_template: "GST 28% - SGPL" }]], today })).toBe("GST 28% - SGPL")
        expect(effectiveItemTaxTemplate({ tables: [[], []], today })).toBeNull()
    })
})

describe("the product's rule on the tax region", () => {
    const regionRates = [
        { id: "txr_18", rate: 18, is_default: true, rules: [] },
        { id: "txr_5", rate: 5, is_default: false, rules: [{ id: "rule_a", reference: "product", reference_id: "prod_1" }] },
        { id: "txr_28", rate: 28, is_default: false, rules: [] },
    ]

    it("moves the product to an existing rate", () => {
        expect(planProductTaxRule({ productId: "prod_1", rate: 28, regionRates })).toEqual({ rate: 28, create: null, addTo: "txr_28", remove: ["rule_a"] })
    })

    it("creates the rate when the region has none at that percentage", () => {
        expect(planProductTaxRule({ productId: "prod_2", rate: 12, regionRates })).toEqual({
            rate: 12,
            create: { name: "GST 12%", code: "GST12", rate: 12 },
            addTo: "created",
            remove: [],
        })
    })

    it("needs no rule for the default rate, or for an Item with no template", () => {
        expect(planProductTaxRule({ productId: "prod_1", rate: 18, regionRates })).toEqual({ rate: 18, create: null, addTo: null, remove: ["rule_a"] })
        expect(planProductTaxRule({ productId: "prod_1", rate: null, regionRates })).toEqual({ rate: 18, create: null, addTo: null, remove: ["rule_a"] })
    })

    it("changes nothing when the product is already there", () => {
        expect(planProductTaxRule({ productId: "prod_1", rate: 5, regionRates })).toEqual({ rate: 5, create: null, addTo: null, remove: [] })
    })
})
