import { describe, expect, it } from "vitest"
import { frappeTypeGroup, suggestConversion } from "../conversion"

describe("what the two sides' types say", () => {
    it("groups Frappe fieldtypes", () => {
        expect(frappeTypeGroup("Data")).toBe("text")
        expect(frappeTypeGroup("Link")).toBe("text")
        expect(frappeTypeGroup("Currency")).toBe("float")
        expect(frappeTypeGroup("Int")).toBe("int")
        expect(frappeTypeGroup("Check")).toBe("check")
        expect(frappeTypeGroup("Datetime")).toBe("datetime")
        expect(frappeTypeGroup("Table MultiSelect")).toBe("table")
        expect(frappeTypeGroup(undefined)).toBe("unknown")
    })

    it("needs nothing when the types agree", () => {
        expect(suggestConversion({ direction: "push", medusaType: "string", frappeType: "Data" })).toEqual({ kind: "none" })
        expect(suggestConversion({ direction: "pull", medusaType: "number", frappeType: "Float" })).toEqual({ kind: "none" })
        expect(suggestConversion({ direction: "push", medusaType: "id", frappeType: "Link" })).toEqual({ kind: "none" })
    })

    it("converts text ↔ number, 0/1 ↔ boolean and dates safely", () => {
        expect(suggestConversion({ direction: "push", medusaType: "string", frappeType: "Currency" })).toMatchObject({ kind: "safe", transform: "number" })
        expect(suggestConversion({ direction: "pull", medusaType: "string", frappeType: "Float" })).toMatchObject({ kind: "safe", transform: "text" })
        expect(suggestConversion({ direction: "push", medusaType: "boolean", frappeType: "Check" })).toMatchObject({ kind: "safe", transform: "check" })
        expect(suggestConversion({ direction: "pull", medusaType: "boolean", frappeType: "Check" })).toMatchObject({ kind: "safe", transform: "boolean" })
        expect(suggestConversion({ direction: "push", medusaType: "datetime", frappeType: "Datetime" })).toMatchObject({ kind: "safe", transform: "datetime_frappe" })
        expect(suggestConversion({ direction: "push", medusaType: "datetime", frappeType: "Date" })).toMatchObject({ kind: "safe", transform: "date_yyyy_mm_dd" })
        expect(suggestConversion({ direction: "pull", medusaType: "datetime", frappeType: "Date" })).toMatchObject({ kind: "safe", transform: "date_iso" })
    })

    it("flags lossy or ambiguous pairs for review instead of converting silently", () => {
        expect(suggestConversion({ direction: "push", medusaType: "string", frappeType: "Int" })).toMatchObject({ kind: "review", transform: "integer" })
        expect(suggestConversion({ direction: "push", medusaType: "number", frappeType: "Int" })).toMatchObject({ kind: "review" })
        expect(suggestConversion({ direction: "push", medusaType: "array", frappeType: "Data" })).toMatchObject({ kind: "review", transform: "join:," })
        expect(suggestConversion({ direction: "pull", medusaType: "boolean", frappeType: "Data" })).toMatchObject({ kind: "review", transform: "boolean" })
    })

    it("says when no scalar transform can make a pair right", () => {
        expect(suggestConversion({ direction: "push", medusaType: "number", frappeType: "Date" })).toMatchObject({ kind: "unmappable" })
        expect(suggestConversion({ direction: "push", medusaType: "string", frappeType: "Table" })).toMatchObject({ kind: "unmappable" })
    })
})
