import { describe, expect, it } from "vitest"
import { customersMissingOnFrappe } from "../customer-recovery"

const customers = [
    { id: "cus_1", email: "a@example.com" },
    { id: "cus_2", email: "B@Example.com" },
    { id: "cus_3", email: "c@example.com" },
    { id: "cus_4", email: null },
]

describe("customers ERPNext has lost", () => {
    it("does not ask for a KYC mark: a customer without one is checked too", () => {
        const out = customersMissingOnFrappe({ customers, frappeEmails: new Set(), frappeNames: new Set(), links: [] })
        expect(out.eligible.map((c) => c.id)).toEqual(["cus_1", "cus_2", "cus_3"])
        expect(out.missing.map((c) => c.id)).toEqual(["cus_1", "cus_2", "cus_3"])
    })

    it("finds a customer by email whatever its case", () => {
        const out = customersMissingOnFrappe({ customers, frappeEmails: new Set(["b@example.com"]), frappeNames: new Set(), links: [] })
        expect(out.missing.map((c) => c.id)).toEqual(["cus_1", "cus_3"])
    })

    it("keeps a customer whose link still resolves although ERPNext holds no email for it", () => {
        const out = customersMissingOnFrappe({
            customers,
            frappeEmails: new Set(),
            frappeNames: new Set(["Cust C"]),
            links: [{ medusa_id: "cus_3", erpnext_name: "Cust C" }],
        })
        expect(out.missing.map((c) => c.id)).toEqual(["cus_1", "cus_2"])
    })

    it("pushes a customer whose linked Customer is gone from ERPNext", () => {
        const out = customersMissingOnFrappe({
            customers,
            frappeEmails: new Set(),
            frappeNames: new Set(),
            links: [{ medusa_id: "cus_3", erpnext_name: "Cust C" }],
        })
        expect(out.missing.map((c) => c.id)).toContain("cus_3")
    })
})
