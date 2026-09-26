import { describe, expect, it } from "vitest"
import { buildAutofill, typeVerdicts } from "../autofill"

describe("auto-map and field types", () => {
    it("sets a safe conversion per direction and leaves an existing transform alone", () => {
        expect(typeVerdicts({ medusaType: "boolean", frappeType: "Check", direction: "both", hasTransform: false, isComposite: false })).toEqual({
            transform_push: "check",
            transform_pull: "boolean",
        })
        expect(typeVerdicts({ medusaType: "boolean", frappeType: "Check", direction: "both", hasTransform: true, isComposite: false })).toEqual({})
        expect(typeVerdicts({ medusaType: "string", frappeType: "Data", direction: "both", hasTransform: false, isComposite: false })).toEqual({})
    })

    it("flags a lossy pair for review with the suggestion, never converting silently", () => {
        const v = typeVerdicts({ medusaType: "string", frappeType: "Int", direction: "push", hasTransform: false, isComposite: false })
        expect(v.transform_push).toBeUndefined()
        expect(v.review?.note).toMatch(/push: .*truncates.*try integer/)
    })

    it("carries the verdicts on the rows it builds", () => {
        const res = buildAutofill({
            direction: "both",
            doctypeFields: [
                { fieldname: "disabled", label: "Disabled", fieldtype: "Check" },
                { fieldname: "weight_per_unit", label: "Weight", fieldtype: "Float" },
            ],
            entityPaths: [
                { path: "disabled", label: "Disabled", type: "boolean" },
                { path: "weight_per_unit", label: "Weight", type: "string" },
            ],
            mode: "matched",
        })
        const disabled = res.rows.find((r) => r.erpnext_field === "disabled")
        expect(disabled).toMatchObject({ transform_push: "check", transform_pull: "boolean" })
        const weight = res.rows.find((r) => r.erpnext_field === "weight_per_unit")
        expect(weight).toMatchObject({ transform_push: "number", transform_pull: "text" })
    })
})
