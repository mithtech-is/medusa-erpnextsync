import { describe, expect, it } from "vitest"
import { mergeDoctypeMeta } from "../doctype-meta"

const base = [
    { fieldname: "customer_name", label: "Customer Name", fieldtype: "Data", reqd: 1 },
    { fieldname: "customer_group", label: "Customer Group", fieldtype: "Link", options: "Customer Group", reqd: 0 },
    { fieldname: "industry", label: "Industry", fieldtype: "Link", options: "Industry Type" },
    { fieldname: "sb_1", fieldtype: "Section Break" },
    { fieldname: "naming_series", label: "Series", fieldtype: "Select", reqd: 1, options: "CUST-.YYYY.-" },
]

describe("mergeDoctypeMeta", () => {
    it("applies a Property Setter that made a standard field mandatory", () => {
        const fields = mergeDoctypeMeta({
            baseFields: base,
            propertySetters: [
                { field_name: "customer_group", property: "reqd", value: "1", doctype_or_field: "DocField" },
                { field_name: "industry", property: "reqd", value: "1", doctype_or_field: "DocField" },
                { field_name: "naming_series", property: "reqd", value: "0", doctype_or_field: "DocField" },
            ],
        })
        const byName = Object.fromEntries(fields.map((f) => [f.fieldname, f]))
        expect(byName.customer_group.reqd).toBe(1)
        expect(byName.industry.reqd).toBe(1)
        expect(byName.naming_series.reqd).toBe(0)
        expect(byName.customer_name.reqd).toBe(1)
    })

    it("lets a Custom Field win over the baseline and a setter win over both", () => {
        const fields = mergeDoctypeMeta({
            baseFields: base,
            customFields: [{ fieldname: "industry", label: "Sector", fieldtype: "Link", options: "Industry Type", reqd: 0 }],
            propertySetters: [{ field_name: "industry", property: "label", value: "Trade", doctype_or_field: "DocField" }],
        })
        const industry = fields.find((f) => f.fieldname === "industry")!
        expect(industry.label).toBe("Trade")
        expect(industry.reqd).toBe(0)
    })

    it("ignores setters on the DocType itself, unknown fields and unread properties", () => {
        const fields = mergeDoctypeMeta({
            baseFields: base,
            propertySetters: [
                { field_name: null, property: "track_changes", value: "1", doctype_or_field: "DocType" },
                { field_name: "no_such_field", property: "reqd", value: "1", doctype_or_field: "DocField" },
                { field_name: "customer_name", property: "bold", value: "1", doctype_or_field: "DocField" },
            ],
        })
        expect(fields.map((f) => f.fieldname)).toEqual(["customer_name", "customer_group", "industry", "naming_series"])
        expect((fields[0] as any).bold).toBeUndefined()
    })

    it("drops layout-only fieldtypes and fills the defaults of the shape", () => {
        const fields = mergeDoctypeMeta({ baseFields: base })
        expect(fields.some((f) => f.fieldtype === "Section Break")).toBe(false)
        expect(fields.find((f) => f.fieldname === "industry")).toEqual({
            fieldname: "industry",
            label: "Industry",
            fieldtype: "Link",
            reqd: 0,
            options: "Industry Type",
            in_list_view: 0,
            hidden: 0,
            read_only: 0,
            default: null,
            fetch_from: null,
        })
    })
})
