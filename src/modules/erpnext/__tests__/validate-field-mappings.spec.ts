import { describe, expect, it } from "vitest"
import { __test__ } from "../index"

const { validateFieldMappings } = __test__

/**
 * What a saved mapping keeps of its field pairs. Everything the mapper
 * can express has to survive this, or the row the engine runs is not the
 * row the operator saw.
 */
describe("saving field pairs", () => {
    it("keeps the per-direction transforms, fixed values and defaults", () => {
        const [pair] = validateFieldMappings([
            {
                medusa_path: "weight",
                erpnext_field: "weight_per_unit",
                direction: "both",
                transform: " trim ",
                transform_push: "number",
                transform_pull: "text",
                default: "0",
                default_push: "1",
                default_pull: "2",
                required: true,
            },
        ])
        expect(pair).toEqual({
            medusa_path: "weight",
            erpnext_field: "weight_per_unit",
            direction: "both",
            transform: "trim",
            transform_push: "number",
            transform_pull: "text",
            default: "0",
            default_push: "1",
            default_pull: "2",
            required: true,
        })
    })

    it("keeps a pull-fixed pair, which has a Medusa path and no Frappe field", () => {
        expect(validateFieldMappings([{ medusa_path: "status", erpnext_field: "", direction: "pull", constant_pull: "published" }])).toEqual([
            { medusa_path: "status", erpnext_field: "", direction: "pull", constant_pull: "published" },
        ])
    })

    it("keeps a push-fixed pair, which has a Frappe field and no Medusa path", () => {
        expect(validateFieldMappings([{ medusa_path: "", erpnext_field: "item_group", constant: "Products" }])).toEqual([
            { medusa_path: "", erpnext_field: "item_group", constant: "Products" },
        ])
    })

    it("keeps Don't Sync", () => {
        expect(validateFieldMappings([{ medusa_path: "cost", erpnext_field: "valuation_rate", direction: "none" }])[0].direction).toBe("none")
    })

    it("drops a pair with nothing to write and blank transforms", () => {
        expect(validateFieldMappings([{ medusa_path: "", erpnext_field: "" }, { medusa_path: "", erpnext_field: "x" }, { medusa_path: "y", erpnext_field: "" }])).toEqual([])
        const [pair] = validateFieldMappings([{ medusa_path: "a", erpnext_field: "b", transform_push: "  " }])
        expect(pair).not.toHaveProperty("transform_push")
    })

    it("pins a combined source to push", () => {
        expect(validateFieldMappings([{ medusa_path: "{first_name} {last_name}", erpnext_field: "customer_name", direction: "both" }])[0].direction).toBe("push")
    })
})
