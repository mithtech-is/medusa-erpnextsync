import { describe, expect, it } from "vitest"

import { formatInvoiceNumber, receivesErpInvoices, storeNumbers } from "../invoice-number"
import { invoiceKey, safeKey, storageProblem } from "../invoice-storage"

describe("the store's invoice series", () => {
    it("pads the running number after the prefix", () => {
        expect(formatInvoiceNumber("WEB-INV-", 42)).toBe("WEB-INV-00042")
    })

    it("refuses a series with no prefix, so it cannot collide with ERPNext's", () => {
        expect(() => formatInvoiceNumber("  ", 1)).toThrow()
    })

    it("refuses a sequence that was never allocated", () => {
        expect(() => formatInvoiceNumber("WEB-", 0)).toThrow()
    })
})

describe("who numbers the invoice", () => {
    it("a store numbering its own invoices receives none from ERPNext", () => {
        expect(storeNumbers({ invoice_numbering: "store" })).toBe(true)
        expect(receivesErpInvoices({ invoice_numbering: "store", send_invoice_to_store: true })).toBe(false)
    })

    it("one series with the PDF option receives ERPNext's invoices", () => {
        expect(receivesErpInvoices({ invoice_numbering: "erpnext", send_invoice_to_store: true })).toBe(true)
    })
})

describe("where the PDF is kept", () => {
    it("keys an invoice by order and number", () => {
        expect(invoiceKey("order_01", "SINV-26-00001")).toBe("invoices/order_01/SINV-26-00001.pdf")
    })

    it("flattens anything that could climb out of the storage root", () => {
        expect(invoiceKey("../../etc", "passwd")).not.toContain("..")
    })

    it("refuses a key that climbs", () => {
        expect(() => safeKey("invoices/../../secret")).toThrow()
    })

    it("S3 without a bucket or credentials is a configuration problem, not a silent public fallback", () => {
        expect(storageProblem({ invoice_storage: "s3" })).toMatch(/bucket/)
        expect(storageProblem({ invoice_storage: "s3", s3_bucket: "b" })).toMatch(/access key/)
        expect(storageProblem({ invoice_storage: "local" })).toBeNull()
    })
})
