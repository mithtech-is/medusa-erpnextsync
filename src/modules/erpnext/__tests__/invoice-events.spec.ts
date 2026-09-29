import { describe, expect, it } from "vitest"
import { invoiceStatusOf, invoiceTotalOf, isDownloadable, salesOrdersBilled } from "../invoice-events"

describe("an ERPNext invoice as the customer sees it", () => {
    it("reads the status from the event, else from the docstatus", () => {
        expect(invoiceStatusOf("on_submit", 1)).toBe("submitted")
        expect(invoiceStatusOf("on_cancel", 2)).toBe("cancelled")
        expect(invoiceStatusOf("on_update", 0)).toBe("draft")
        expect(invoiceStatusOf(null, 1)).toBe("submitted")
        expect(invoiceStatusOf(undefined, 2)).toBe("cancelled")
    })

    it("offers only a submitted invoice whose PDF is kept", () => {
        expect(isDownloadable({ status: "submitted", object_key: "invoices/o/SINV-26-00001.pdf" })).toBe(true)
        expect(isDownloadable({ status: "draft", object_key: "invoices/o/SINV-26-00001.pdf" })).toBe(false)
        expect(isDownloadable({ status: "cancelled", object_key: "invoices/o/SINV-26-00001.pdf" })).toBe(false)
        expect(isDownloadable({ status: "submitted", object_key: null })).toBe(false)
    })

    it("finds the Sales Orders billed, once each", () => {
        expect(salesOrdersBilled([{ sales_order: "SO-1" }, { sales_order: "" }, { sales_order: "SO-1" }, { sales_order: "SO-2" }])).toEqual(["SO-1", "SO-2"])
        expect(salesOrdersBilled(null)).toEqual([])
    })

    it("totals at the rounded amount unless rounding is off", () => {
        expect(invoiceTotalOf({ grand_total: 1297.6, rounded_total: 1298 })).toBe(1298)
        expect(invoiceTotalOf({ grand_total: 1297.6, rounded_total: 0, disable_rounded_total: 1 })).toBe(1297.6)
        expect(invoiceTotalOf({ grand_total: 1297.6, rounded_total: 1298, disable_rounded_total: 1 })).toBe(1297.6)
        expect(invoiceTotalOf({})).toBe(null)
    })
})
