import { describe, expect, it } from "vitest"
import {
    doctypeOfPair,
    linkFieldFilled,
    mainNameFromSecondaryDoc,
    normalizeSecondaryDoctypes,
    pairsForDoctype,
    pairsForPull,
    secondaryLinkPayload,
    secondaryLookupFilters,
    splitPairsByDoctype,
} from "../secondary-doctypes"

const contact = { doctype: "Contact", link_kind: "dynamic_links" as const }
const invoice = { doctype: "Sales Invoice", link_kind: "field" as const, link_field: "customer" }
const pairs = [
    { medusa_path: "email", erpnext_field: "email_id" },
    { medusa_path: "first_name", erpnext_field: "first_name", erpnext_doctype: "Contact" },
    { medusa_path: "phone", erpnext_field: "phone", erpnext_doctype: "Contact" },
    { medusa_path: "", erpnext_field: "customer_group", constant: "Individual", erpnext_doctype: "Customer" },
]

describe("normalizeSecondaryDoctypes", () => {
    it("keeps one row per DocType, drops the main one and a field link with no field", () => {
        expect(
            normalizeSecondaryDoctypes(
                [
                    { doctype: "Contact", link_kind: "dynamic_links" },
                    { doctype: "Contact", link_kind: "dynamic_links" },
                    { doctype: "Customer", link_kind: "field", link_field: "x" },
                    { doctype: "Sales Invoice", link_kind: "field", link_field: " customer " },
                    { doctype: "Address", link_kind: "field" },
                    { doctype: "" },
                ],
                "Customer",
            ),
        ).toEqual([
            { doctype: "Contact", link_kind: "dynamic_links", link_field: null },
            { doctype: "Sales Invoice", link_kind: "field", link_field: "customer" },
        ])
        expect(normalizeSecondaryDoctypes(null)).toEqual([])
    })
})

describe("pairs by DocType", () => {
    it("targets the main DocType unless a pair says otherwise", () => {
        expect(doctypeOfPair({}, "Customer")).toBe("Customer")
        expect(doctypeOfPair({ erpnext_doctype: " Contact " }, "Customer")).toBe("Contact")
        expect(pairsForDoctype(pairs, "Customer", "Customer").map((p) => p.erpnext_field)).toEqual(["email_id", "customer_group"])
        expect(pairsForDoctype(pairs, "Customer", "Contact").map((p) => p.erpnext_field)).toEqual(["first_name", "phone"])
        const split = splitPairsByDoctype(pairs, "Customer")
        expect(Array.from(split.keys())).toEqual(["Customer", "Contact"])
    })
    it("turns a secondary pair into a dot path for the pull and leaves the rest alone", () => {
        const out = pairsForPull(pairs, "Customer")
        expect(out[0]).toEqual(pairs[0])
        expect(out[1]).toEqual({ medusa_path: "first_name", erpnext_field: "Contact.first_name" })
        expect(out[3].erpnext_field).toBe("customer_group")
    })
})

describe("links between the main and a secondary document", () => {
    it("finds and ties a Contact through its Links table", () => {
        expect(secondaryLookupFilters(contact, "Customer", "CRN-1")).toEqual([
            ["Dynamic Link", "link_doctype", "=", "Customer"],
            ["Dynamic Link", "link_name", "=", "CRN-1"],
        ])
        expect(secondaryLinkPayload(contact, "Customer", "CRN-1")).toEqual({ links: [{ link_doctype: "Customer", link_name: "CRN-1" }] })
        expect(mainNameFromSecondaryDoc(contact, "Customer", { links: [{ link_doctype: "Lead", link_name: "L-1" }, { link_doctype: "Customer", link_name: "CRN-1" }] })).toBe("CRN-1")
        expect(mainNameFromSecondaryDoc(contact, "Customer", { links: [] })).toBeNull()
        expect(linkFieldFilled(contact)).toBe("links")
    })
    it("finds and ties a document through a Link field", () => {
        expect(secondaryLookupFilters(invoice, "Customer", "CRN-1")).toEqual([["customer", "=", "CRN-1"]])
        expect(secondaryLinkPayload(invoice, "Customer", "CRN-1")).toEqual({ customer: "CRN-1" })
        expect(mainNameFromSecondaryDoc(invoice, "Customer", { customer: "CRN-1" })).toBe("CRN-1")
        expect(mainNameFromSecondaryDoc(invoice, "Customer", {})).toBeNull()
        expect(linkFieldFilled(invoice)).toBe("customer")
    })
})
