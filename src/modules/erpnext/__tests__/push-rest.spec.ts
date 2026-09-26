import { describe, expect, it } from "vitest"
import {
    addressesOfCustomer,
    addressesOfOrder,
    buildAddressDoc,
    buildCustomerDoc,
    buildSalesInvoiceDoc,
    buildSalesOrderDoc,
    customerDisplayName,
    directionForCreated,
    isOwnWrite,
    money,
    orderFullyPaid,
    orderTotals,
    transportFilledFields,
    wantsSalesInvoice,
    wantsSalesOrder,
    withTemplateTaxes,
} from "../push-rest"

const has = (fields: string[]) => (f: string) => fields.includes(f)
const defaults = { company: "FIXCENT INDIA PRIVATE LIMITED", priceList: "Standard Selling" }

describe("money", () => {
    it("is the major unit, to two places, and never NaN", () => {
        expect(money(1499)).toBe(1499)
        expect(money("18218.024")).toBe(18218.02)
        expect(money(null)).toBe(0)
        expect(money("x")).toBe(0)
    })
})

describe("the Customer document", () => {
    const record = { email: "Amit@Example.com", first_name: "Amit", last_name: "Rao", phone: "98450 12345" }

    it("fills the mandatory fields from the record and lets a mapped value win", () => {
        const doc = buildCustomerDoc({ record, mapped: { customer_name: "Mapped Name" }, has: has(["email_id", "mobile_no"]), defaults })
        expect(doc).toEqual({ customer_name: "Mapped Name", customer_type: "Individual", email_id: "amit@example.com", mobile_no: "98450 12345" })
    })

    it("is a Company with GST fields when the site has them and the record carries a GSTIN", () => {
        const doc = buildCustomerDoc({
            record: { ...record, company_trade_name: "Rao Traders", gstin: "29ABCDE1234F1Z5" },
            mapped: {},
            has: has(["email_id", "gstin", "gst_category", "customer_group"]),
            defaults: { ...defaults, customerGroup: "Commercial" },
        })
        expect(doc).toMatchObject({ customer_name: "Rao Traders", customer_type: "Company", gstin: "29ABCDE1234F1Z5", gst_category: "Registered Regular", customer_group: "Commercial" })
        expect(doc).not.toHaveProperty("mobile_no")
    })

    it("names a customer by company, then person, then email", () => {
        expect(customerDisplayName({ company_name: "ACME", first_name: "A" })).toBe("ACME")
        expect(customerDisplayName({ first_name: "A", last_name: "B" })).toBe("A B")
        expect(customerDisplayName({ email: "x@y.z" })).toBe("x@y.z")
    })
})

describe("addresses", () => {
    it("come from the customer's own list and the company's billing address", () => {
        const list = addressesOfCustomer({
            gstin: "29X",
            company_trade_name: "Rao Traders",
            company_id_resolved: "comp_1",
            addresses: [
                { id: "addr_1", address_1: "1 Main St", city: "Bengaluru", country_code: "in", is_default_shipping: true },
                { id: "addr_2", address_1: "2 Side St", city: "Mysuru", country_code: "in", is_default_billing: true },
            ],
            company_billing_address: { line1: "HQ", city: "Bengaluru", country_code: "in" },
        })
        expect(list.map((a) => [a.id, a.kind, a.gstin ?? null])).toEqual([
            ["addr_1", "Shipping", null],
            ["addr_2", "Billing", null],
            ["company:comp_1", "Billing", "29X"],
        ])
        expect(addressesOfOrder({ billing_address: { id: "b", address_1: "x", city: "y" }, shipping_address: { id: "s", address_1: "x", city: "y" } }).map((a) => a.kind)).toEqual(["Billing", "Shipping"])
    })

    it("build a linked Address by Country name, with GST fields when the site has them", () => {
        const out = buildAddressDoc({
            input: { id: "addr_1", kind: "Billing", line1: "1 Main St", city: "Bengaluru", state: "Karnataka", postal_code: "560001", country_code: "in", gstin: "29X" },
            customerName: "Rao Traders",
            countryName: "India",
            has: has(["gstin", "gst_category"]),
        })
        expect(out.ok).toBe(true)
        if (out.ok) {
            expect(out.doc).toMatchObject({ address_title: "Rao Traders", address_type: "Billing", address_line1: "1 Main St", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India", gstin: "29X", gst_category: "Registered Regular" })
            expect(out.doc.links).toEqual([{ link_doctype: "Customer", link_name: "Rao Traders" }])
        }
    })

    it("refuse an address ERPNext would refuse", () => {
        expect(buildAddressDoc({ input: { id: "a", kind: "Billing", city: "x" }, customerName: "c", countryName: "India", has: has([]) })).toMatchObject({ ok: false })
        expect(buildAddressDoc({ input: { id: "a", kind: "Billing", line1: "x", city: "y", country_code: "zz" }, customerName: "c", countryName: null, has: has([]) })).toMatchObject({ ok: false, reason: expect.stringMatching(/Country/) })
    })
})

describe("the Sales Order", () => {
    const order = {
        id: "order_1",
        display_id: 42,
        currency_code: "inr",
        created_at: "2026-09-26T04:30:00.000Z",
        total: 3538.82,
        items: [
            { id: "li_1", title: "Bolt", quantity: 2, unit_price: 1499, tax_total: 539.64, variant: { sku: "BOLT-1" } },
        ],
    }
    const codes = new Map([["li_1", "BOLT-1"]])
    const itemCodeFor = (li: any) => codes.get(li.id) ?? null

    it("carries the lines, the dates in the site's timezone, and reconciles the total as shipping", () => {
        const out = buildSalesOrderDoc({ order, customerName: "Rao Traders", itemCodeFor, addresses: { billing: "Rao Traders-Billing" }, defaults: { ...defaults, shippingAccount: "Freight - FIPL" }, has: has([]), timezone: "Asia/Kolkata" })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.doc).toMatchObject({
            customer: "Rao Traders",
            order_type: "Sales",
            transaction_date: "2026-09-26",
            delivery_date: "2026-10-03",
            po_no: "#42",
            currency: "INR",
            company: "FIXCENT INDIA PRIVATE LIMITED",
            selling_price_list: "Standard Selling",
            customer_address: "Rao Traders-Billing",
        })
        expect(out.doc.items).toEqual([{ item_code: "BOLT-1", item_name: "Bolt", qty: 2, rate: 1499, delivery_date: "2026-10-03" }])
        // 3538.82 − 2×1499 − 539.64 = 1.18 of shipping
        expect(out.doc.taxes).toEqual([{ charge_type: "Actual", account_head: "Freight - FIPL", description: "Shipping", tax_amount: 1.18 }])
        expect(out.notes).toEqual([])
    })

    it("says when shipping cannot be booked, and books a discount on the grand total", () => {
        const discounted = { ...order, total: 3400 }
        const out = buildSalesOrderDoc({ order: discounted, customerName: "c", itemCodeFor, addresses: {}, defaults, has: has(["medusa_order_id"]) })
        expect(out.ok).toBe(true)
        if (!out.ok) return
        expect(out.doc).toMatchObject({ apply_discount_on: "Grand Total", discount_amount: 137.64, medusa_order_id: "order_1" })
        expect(out.doc).not.toHaveProperty("taxes")
        const unbooked = buildSalesOrderDoc({ order, customerName: "c", itemCodeFor, addresses: {}, defaults, has: has([]) })
        expect(unbooked.ok && unbooked.notes[0]).toMatch(/shipping 1.18 not booked/)
    })

    it("stops on a line with no ERPNext Item, naming it", () => {
        const out = buildSalesOrderDoc({ order, customerName: "c", itemCodeFor: () => null, addresses: {}, defaults, has: has([]) })
        expect(out).toMatchObject({ ok: false, missing: ["BOLT-1"] })
        expect(buildSalesOrderDoc({ order: { ...order, items: [] }, customerName: "c", itemCodeFor, addresses: {}, defaults, has: has([]) })).toMatchObject({ ok: false })
    })

    it("totals: known shipping and discount win over the residual", () => {
        expect(orderTotals({ total: 100, shipping_total: 10, discount_total: 5, items: [{ unit_price: 95, quantity: 1, tax_total: 0 }] })).toEqual({ subtotal: 95, tax: 0, shipping: 10, discount: 5, grand: 100 })
    })
})

describe("invoicing rules", () => {
    it("an order is fully paid when captures cover the total or Medusa says captured", () => {
        expect(orderFullyPaid({ total: 100, payments: [{ amount: 60 }, { amount: 40 }] })).toBe(true)
        expect(orderFullyPaid({ total: 100, payments: [{ amount: 60 }] })).toBe(false)
        expect(orderFullyPaid({ total: 100, payment_status: "captured", payments: [] })).toBe(true)
        expect(orderFullyPaid({ total: 0, payments: [] })).toBe(false)
    })

    it("unset order document means Sales Order and Sales Invoice", () => {
        expect(wantsSalesOrder(null)).toBe(true)
        expect(wantsSalesInvoice(null)).toBe(true)
        expect(wantsSalesInvoice("Sales Order")).toBe(false)
        expect(wantsSalesOrder("Sales Order and Sales Invoice")).toBe(true)
    })
})

describe("echo and ownership", () => {
    it("a document the API user last modified is our own write coming home", () => {
        expect(isOwnWrite({ modified_by: "medusync@splendx.local" }, "MEDUSYNC@splendx.local")).toBe(true)
        expect(isOwnWrite({ modified_by: "someone@example.com" }, "medusync@splendx.local")).toBe(false)
        expect(isOwnWrite({ modified_by: "medusync@splendx.local" }, null)).toBe(false)
    })

    it("a document a push creates is Medusa-owned, or Both for a two-way mapping", () => {
        expect(directionForCreated("push")).toBe("Medusa → ERPNext")
        expect(directionForCreated("both")).toBe("Both")
    })
})

describe("transportFilledFields", () => {
    it("names what the Customer push fills itself, and the settings-backed ones only when set", () => {
        const bare = transportFilledFields("Customer", {})
        expect(bare.has("customer_name")).toBe(true)
        expect(bare.has("customer_type")).toBe(true)
        expect(bare.has("customer_group")).toBe(false)
        expect(bare.has("industry")).toBe(false)
        const withDefaults = transportFilledFields("Customer", { customerGroup: "Individual", territory: "India" })
        expect(withDefaults.has("customer_group")).toBe(true)
        expect(withDefaults.has("territory")).toBe(true)
    })

    it("covers a sales document's party, dates, currency and lines", () => {
        const so = transportFilledFields("Sales Order", { company: "Mith" })
        for (const f of ["customer", "transaction_date", "delivery_date", "currency", "selling_price_list", "items", "company"]) {
            expect(so.has(f)).toBe(true)
        }
        expect(so.has("taxes_and_charges")).toBe(false)
        expect(transportFilledFields("Sales Order", {}).has("company")).toBe(false)
        expect(transportFilledFields("Item", { company: "Mith" }).size).toBe(0)
    })
})

describe("the Sales Invoice built against a draft Sales Order", () => {
    const order = {
        id: "order_1",
        display_id: 7,
        created_at: "2026-09-13T08:00:00Z",
        currency_code: "inr",
        total: 3537.64,
        items: [
            { id: "li_1", title: "Bolt", quantity: 2, unit_price: 1499, total: 2998, tax_total: 539.64, variant: { sku: "BOLT-1" } },
        ],
    }
    const defaults = { company: "Fixcent", priceList: "Standard Selling" }
    const has = (fields: string[]) => (f: string) => fields.includes(f)
    const itemCodeFor = (li: any) => (li?.variant?.sku === "BOLT-1" ? "BOLT-1" : null)
    const now = new Date("2026-09-26T10:00:00Z")

    it("drops the order-only fields, dates itself today and names the draft order's rows", () => {
        const out = buildSalesInvoiceDoc({
            order, customerName: "Rao Traders", itemCodeFor, addresses: {}, defaults, has: has(["custom_sales_type"]), timezone: "Asia/Kolkata", now,
            soName: "SAL-ORD-2026-00271", soItems: [{ name: "row1", item_code: "BOLT-1" }],
            payload: { custom_sales_type: "Service & Sales", contact_email: "x@y.z", items: [] },
        })
        expect(out.ok).toBe(true)
        if (out.ok === false) return
        expect(out.doc.order_type).toBeUndefined()
        expect(out.doc.delivery_date).toBeUndefined()
        expect(out.doc).toMatchObject({ posting_date: "2026-09-26", due_date: "2026-09-26", set_posting_time: 1, po_no: "#7", customer: "Rao Traders", custom_sales_type: "Service & Sales" })
        expect(out.doc.contact_email).toBeUndefined()
        expect(out.doc.items).toEqual([{ item_code: "BOLT-1", item_name: "Bolt", qty: 2, rate: 1499, sales_order: "SAL-ORD-2026-00271", so_detail: "row1" }])
    })

    it("leaves a line unlinked when the order has no row for it, and links nothing without an order", () => {
        const out = buildSalesInvoiceDoc({ order, customerName: "c", itemCodeFor, addresses: {}, defaults, has: has([]), now, soName: "SO-1", soItems: [{ name: "r9", item_code: "OTHER" }] })
        if (out.ok === false) throw new Error(out.reason)
        expect(out.doc.items[0].sales_order).toBeUndefined()
        const bare = buildSalesInvoiceDoc({ order, customerName: "c", itemCodeFor, addresses: {}, defaults, has: has([]), now })
        if (bare.ok === false) throw new Error(bare.reason)
        expect(bare.doc.items[0].so_detail).toBeUndefined()
    })

    it("promises delivery a week from now when the order is older than today", () => {
        const so = buildSalesOrderDoc({ order, customerName: "c", itemCodeFor, addresses: {}, defaults, has: has([]), timezone: "Asia/Kolkata", now })
        if (so.ok === false) throw new Error(so.reason)
        expect(so.doc.transaction_date).toBe("2026-09-13")
        expect(so.doc.delivery_date).toBe("2026-10-03")
    })
})

describe("withTemplateTaxes", () => {
    it("puts the template's rows ahead of the shipping row, stripped of Frappe's row bookkeeping", () => {
        const doc = { customer: "c", taxes: [{ charge_type: "Actual", account_head: "Freight - F", tax_amount: 100 }] }
        const out = withTemplateTaxes(doc, [
            { name: "abc", idx: 1, parent: "T", parenttype: "Sales Taxes and Charges Template", doctype: "Sales Taxes and Charges", charge_type: "On Net Total", account_head: "Output Tax CGST - F", rate: 9, description: "CGST" },
            { name: "def", idx: 2, charge_type: "On Net Total", account_head: "Output Tax SGST - F", rate: 9, description: "SGST" },
        ])
        expect(out.taxes).toEqual([
            { charge_type: "On Net Total", account_head: "Output Tax CGST - F", rate: 9, description: "CGST" },
            { charge_type: "On Net Total", account_head: "Output Tax SGST - F", rate: 9, description: "SGST" },
            { charge_type: "Actual", account_head: "Freight - F", tax_amount: 100 },
        ])
        expect(doc.taxes).toHaveLength(1)
    })
    it("leaves the document alone without a template", () => {
        const doc = { customer: "c" }
        expect(withTemplateTaxes(doc, null)).toBe(doc)
        expect(withTemplateTaxes(doc, [])).toBe(doc)
    })
})
