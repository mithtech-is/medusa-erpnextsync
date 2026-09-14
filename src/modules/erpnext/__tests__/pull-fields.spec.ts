import { describe, expect, it } from "vitest"
import { __test__ } from "../index"

/**
 * A pull asks Frappe for a named list of fields. Ask for one the doctype
 * has not got and Frappe rejects the entire page with HTTP 417, so a
 * single push-only pair takes the whole sync down.
 */
describe("the fields a pull asks Frappe for", () => {
    const uniqueFrappeFields = (__test__ as any).uniqueFrappeFields

    it("always asks for name and modified", () => {
        expect(uniqueFrappeFields([], "")).toEqual(expect.arrayContaining(["name", "modified"]))
    })

    it("includes the key field and every pull pair", () => {
        const fields = uniqueFrappeFields(
            [
                { erpnext_field: "item_name", medusa_path: "title", direction: "pull" },
                { erpnext_field: "description", medusa_path: "description", direction: "pull" },
            ] as any,
            "item_code",
        )
        expect(fields).toEqual(expect.arrayContaining(["item_code", "item_name", "description"]))
    })

    it("leaves out a push-only pair, which is not a column here", () => {
        const fields = uniqueFrappeFields(
            [
                { erpnext_field: "item_name", medusa_path: "title", direction: "pull" },
                { erpnext_field: "medusa_product_id", medusa_path: "id", direction: "push" },
            ] as any,
            "item_code",
        )
        expect(fields).toContain("item_name")
        expect(fields).not.toContain("medusa_product_id")
    })

    it("keeps a two-way pair, which does exist on both sides", () => {
        const fields = uniqueFrappeFields(
            [{ erpnext_field: "email_id", medusa_path: "email", direction: "both" }] as any,
            "name",
        )
        expect(fields).toContain("email_id")
    })

    it("asks for nothing twice", () => {
        const fields = uniqueFrappeFields(
            [{ erpnext_field: "name", medusa_path: "id", direction: "pull" }] as any,
            "name",
        )
        expect(fields.filter((f: string) => f === "name")).toHaveLength(1)
    })
})
