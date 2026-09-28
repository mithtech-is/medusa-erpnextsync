import { describe, expect, it } from "vitest"
import {
    addressKind,
    addressesOfCustomer,
    addressesOfOrder,
    buildAddressDoc,
    buildCustomerDoc,
    buildSalesInvoiceDoc,
    buildSalesOrderDoc,
    customerDisplayName,
    directionForCreated,
    gstinForAddress,
    isOwnWrite,
    money,
    orderFullyPaid,
    orderTotals,
    primaryContactPatch,
    salesLine,
    shippingNet,
    supplyTaxes,
    gstStateCodeOf,
    withOrderContact,
    transportFilledFields,
    wantsSalesInvoice,
    wantsSalesOrder,
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

    it("gives a new customer the Settings group, territory and GST category", () => {
        const doc = buildCustomerDoc({
            record,
            mapped: {},
            has: has(["customer_group", "territory", "gst_category"]),
            defaults: { ...defaults, customerGroup: "Individual", territory: "India" },
            remote: null,
        })
        expect(doc).toMatchObject({ customer_group: "Individual", territory: "India", gst_category: "Unregistered" })
    })

    it("leaves an existing customer's group, territory and GST category as ERPNext has them", () => {
        const doc = buildCustomerDoc({
            record,
            mapped: {},
            has: has(["customer_group", "territory", "gst_category"]),
            defaults: { ...defaults, customerGroup: "Individual", territory: "India" },
            remote: { customer_group: "Commercial", territory: "Rest Of The World", gst_category: "Registered Regular" },
        })
        expect(doc).not.toHaveProperty("customer_group")
        expect(doc).not.toHaveProperty("territory")
        expect(doc).not.toHaveProperty("gst_category")
    })

    it("fills an existing customer's blank group and territory from Settings", () => {
        const doc = buildCustomerDoc({
            record,
            mapped: {},
            has: has(["customer_group", "territory"]),
            defaults: { ...defaults, customerGroup: "Individual", territory: "India" },
            remote: { customer_group: null, territory: "" },
        })
        expect(doc).toMatchObject({ customer_group: "Individual", territory: "India" })
    })

    it("still marks an existing customer registered when the store sends a GSTIN", () => {
        const doc = buildCustomerDoc({
            record,
            mapped: { gstin: "29ZZZPZ0001Z1Z5" },
            has: has(["gstin", "gst_category"]),
            defaults,
            remote: { gst_category: "Unregistered" },
        })
        expect(doc).toMatchObject({ gstin: "29ZZZPZ0001Z1Z5", gst_category: "Registered Regular" })
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

    it("carries the lines at their price, the dates in the site's timezone, and the company address", () => {
        // now === the order date, so delivery is a week out from a fixed clock, not the wall clock.
        const out = buildSalesOrderDoc({ order, customerName: "Rao Traders", itemCodeFor, addresses: { billing: "Rao Traders-Billing" }, defaults: { ...defaults, companyAddress: "Fixcent-Billing" }, has: has([]), timezone: "Asia/Kolkata", now: new Date("2026-09-26T04:30:00.000Z") })
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
            company_address: "Fixcent-Billing",
            selling_price_list: "Standard Selling",
            customer_address: "Rao Traders-Billing",
            ignore_pricing_rule: 1,
        })
        expect(out.doc.items).toEqual([
            { item_code: "BOLT-1", item_name: "Bolt", qty: 2, price_list_rate: 1499, discount_amount: 0, rate: 1499, delivery_date: "2026-10-03" },
        ])
        // Taxes are ERPNext's to choose; the builder sends none and no document-level discount.
        expect(out.doc).not.toHaveProperty("taxes")
        expect(out.doc).not.toHaveProperty("taxes_and_charges")
        expect(out.doc).not.toHaveProperty("discount_amount")
        expect(out.notes).toEqual([])
    })

    it("puts a promotion on the line it hit, before tax", () => {
        const discounted = { ...order, items: [{ ...order.items[0], adjustments: [{ amount: 199.8 }, { amount: 100 }] }] }
        const out = buildSalesOrderDoc({ order: discounted, customerName: "c", itemCodeFor, addresses: {}, defaults, has: has(["medusa_order_id"]) })
        expect(out.ok && out.doc.items[0]).toMatchObject({ qty: 2, price_list_rate: 1499, discount_amount: 149.9, rate: 1349.1 })
        expect(out.ok && out.doc).toMatchObject({ medusa_order_id: "order_1" })
    })

    it("stops on a line with no ERPNext Item, naming it", () => {
        const out = buildSalesOrderDoc({ order, customerName: "c", itemCodeFor: () => null, addresses: {}, defaults, has: has([]) })
        expect(out).toMatchObject({ ok: false, missing: ["BOLT-1"] })
        expect(buildSalesOrderDoc({ order: { ...order, items: [] }, customerName: "c", itemCodeFor, addresses: {}, defaults, has: has([]) })).toMatchObject({ ok: false })
    })

    it("totals: shipping is net of its tax, and known figures win over the residual", () => {
        expect(orderTotals({ total: 100, shipping_subtotal: 10, discount_total: 5, items: [{ unit_price: 95, quantity: 1, tax_total: 0 }] })).toEqual({ subtotal: 95, tax: 0, shipping: 10, discount: 5, grand: 100 })
        expect(orderTotals({ total: 3538.82, items: order.items })).toMatchObject({ shipping: 1.18 })
    })

    it("reads net shipping from the subtotal, the methods, or the total less its tax", () => {
        expect(shippingNet({ shipping_subtotal: 199, shipping_total: 234.82 })).toBe(199)
        expect(shippingNet({ shipping_methods: [{ amount: 199, adjustments: [{ amount: 50 }] }, { amount: 10 }] })).toBe(159)
        expect(shippingNet({ shipping_total: 234.82, shipping_tax_total: 35.82 })).toBe(199)
        expect(shippingNet({})).toBeNull()
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
        // ERPNext chooses the taxes and the push sends them, with the company address.
        for (const f of ["taxes_and_charges", "taxes", "company_address"]) expect(so.has(f)).toBe(true)
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
        expect(out.doc.items).toEqual([{ item_code: "BOLT-1", item_name: "Bolt", qty: 2, price_list_rate: 1499, discount_amount: 0, rate: 1499, sales_order: "SAL-ORD-2026-00271", so_detail: "row1" }])
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

describe("the tax rows of a sales document", () => {
    const gstRows = [
        { name: "row-1", idx: 1, parent: "x", charge_type: "On Net Total", account_head: "Output Tax SGST - SGPL", rate: 9, description: "SGST" },
        { name: "row-2", idx: 2, parent: "x", charge_type: "On Net Total", account_head: "Output Tax CGST - SGPL", rate: 9, description: "CGST" },
    ]

    it("puts shipping ahead of the GST rows, which then tax it at each line's rate", () => {
        const out = supplyTaxes({ gstRows, shipping: 100, shippingAccount: "Freight and Forwarding Charges - SGPL" })
        expect(out.notes).toEqual([])
        expect(out.taxes).toEqual([
            { charge_type: "Actual", account_head: "Freight and Forwarding Charges - SGPL", description: "Shipping", tax_amount: 100 },
            { charge_type: "On Previous Row Total", row_id: "1", account_head: "Output Tax SGST - SGPL", rate: 9, description: "SGST" },
            { charge_type: "On Previous Row Total", row_id: "1", account_head: "Output Tax CGST - SGPL", rate: 9, description: "CGST" },
        ])
    })

    it("sends ERPNext's rows as they are without shipping", () => {
        const out = supplyTaxes({ gstRows, shipping: 0, shippingAccount: "Freight" })
        expect(out.taxes.map((t) => t.charge_type)).toEqual(["On Net Total", "On Net Total"])
        expect(out.taxes[0]).not.toHaveProperty("name")
    })

    it("says when shipping cannot be booked", () => {
        const out = supplyTaxes({ gstRows, shipping: 199, shippingAccount: null })
        expect(out.taxes).toHaveLength(2)
        expect(out.notes[0]).toMatch(/shipping 199 not booked/)
    })
})

describe("a sales line", () => {
    it("rounds the per-unit discount and the net rate to the paisa, as ERPNext does", () => {
        expect(salesLine({ unit_price: 1234.55, quantity: 2, adjustments: [{ amount: 246.91 }] })).toEqual({ price_list_rate: 1234.55, discount_amount: 123.46, rate: 1111.09, qty: 2 })
        expect(salesLine({ unit_price: 1599, quantity: 1 })).toEqual({ price_list_rate: 1599, discount_amount: 0, rate: 1599, qty: 1 })
    })
})

describe("the primary Contact", () => {
    const contact = {
        name: "Amit Rao",
        email_ids: [{ name: "e1", email_id: "amit@example.com", is_primary: 1, doctype: "Contact Email", parent: "Amit Rao" }],
        phone_nos: [{ name: "p1", phone: "+919845012345", is_primary_mobile_no: 1, is_primary_phone: 0 }],
    }

    it("changes nothing when the Contact already has the store's values", () => {
        expect(primaryContactPatch(contact, { email: "Amit@Example.com", phone: "+91 98450 12345" })).toBeNull()
    })

    it("puts a new phone on the primary mobile row, keeping the row", () => {
        const patch = primaryContactPatch(contact, { phone: "+919000000004" })
        expect(patch).toEqual({ phone_nos: [{ name: "p1", phone: "+919000000004", is_primary_mobile_no: 1, is_primary_phone: 0 }] })
    })

    it("makes an existing row primary rather than duplicating it", () => {
        const two = { ...contact, email_ids: [...contact.email_ids, { name: "e2", email_id: "rao@work.in", is_primary: 0 }] }
        const patch = primaryContactPatch(two, { email: "rao@work.in" })
        expect(patch?.email_ids).toEqual([
            { name: "e1", email_id: "amit@example.com", is_primary: 0 },
            { name: "e2", email_id: "rao@work.in", is_primary: 1 },
        ])
    })

    it("adds a primary row to a Contact that has none", () => {
        const patch = primaryContactPatch({ email_ids: [], phone_nos: [] }, { email: "new@x.in", phone: "+919000000001" })
        expect(patch).toEqual({
            email_ids: [{ email_id: "new@x.in", is_primary: 1 }],
            phone_nos: [{ phone: "+919000000001", is_primary_mobile_no: 1 }],
        })
    })

    it("gives a nameless Contact the store's person, and never renames one", () => {
        expect(primaryContactPatch({ first_name: "", email_ids: [], phone_nos: [] }, { first_name: "Asha", last_name: "Rao" })).toEqual({ first_name: "Asha", last_name: "Rao" })
        expect(primaryContactPatch({ first_name: "Asha K", email_ids: [], phone_nos: [] }, { first_name: "Asha", last_name: "Rao" })).toBeNull()
    })

    it("ignores blank values and a missing Contact", () => {
        expect(primaryContactPatch(contact, { email: "", phone: null })).toBeNull()
        expect(primaryContactPatch(null, { email: "a@b.c" })).toBeNull()
    })
})

describe("the customer as an order knows them", () => {
    const order = { billing_address: { first_name: "ZZ Test", last_name: "Sync 2", phone: "+919000000009", company: "" } }

    it("names a nameless guest from the billing address", () => {
        const rec = withOrderContact({ id: "cus_1", email: "g@x.in", first_name: null, last_name: "" }, order)
        expect(rec).toMatchObject({ first_name: "ZZ Test", last_name: "Sync 2", phone: "+919000000009" })
        expect(customerDisplayName(rec)).toBe("ZZ Test Sync 2")
    })

    it("keeps what the customer record already says", () => {
        const rec = withOrderContact({ id: "cus_1", first_name: "Amit", last_name: "Rao", phone: "+911" }, order)
        expect(rec).toMatchObject({ first_name: "Amit", last_name: "Rao", phone: "+911" })
    })

    it("leaves a record alone when the order has no address", () => {
        const rec = { id: "cus_1" }
        expect(withOrderContact(rec, {})).toBe(rec)
    })
})

describe("GST state codes", () => {
    it("come from a state's name, an alias or the code itself", () => {
        expect(gstStateCodeOf("Karnataka")).toBe("29")
        expect(gstStateCodeOf("NCT of Delhi")).toBe("07")
        expect(gstStateCodeOf("27")).toBe("27")
        expect(gstStateCodeOf("7")).toBe("07")
        expect(gstStateCodeOf("Atlantis")).toBeNull()
        expect(gstStateCodeOf(null)).toBeNull()
    })
})

describe("GSTIN on addresses", () => {
    const G = "29ZZZPZ0001Z1Z5"

    it("puts the customer's GSTIN on an address in the GSTIN's state only", () => {
        expect(gstinForAddress("Karnataka", null, G)).toBe(G)
        expect(gstinForAddress("Maharashtra", null, G)).toBeNull()
        expect(gstinForAddress("Somewhere", null, G)).toBeNull()
    })

    it("keeps a GSTIN typed for the address, unless it belongs to another state", () => {
        expect(gstinForAddress("karnataka", " 29zzzpz0001z1z5 ", null)).toBe(G)
        expect(gstinForAddress("Maharashtra", G, null)).toBeNull()
        expect(gstinForAddress("Unknownland", G, null)).toBe(G)
    })

    it("reads state aliases and ignores malformed GSTINs", () => {
        expect(gstinForAddress("NCT of Delhi", "07AAAAA0000A1Z5", null)).toBe("07AAAAA0000A1Z5")
        expect(gstinForAddress("Karnataka", "29X", null)).toBeNull()
    })

    it("gives a customer's saved addresses in that state the customer's GSTIN", () => {
        const list = addressesOfCustomer({
            metadata: { gstin: G },
            addresses: [
                { id: "a1", address_1: "1 Main St", city: "Bengaluru", province: "Karnataka", country_code: "in" },
                { id: "a2", address_1: "2 Side St", city: "Pune", province: "Maharashtra", country_code: "in" },
            ],
        })
        expect(list.map((a) => [a.id, a.gstin])).toEqual([["a1", G], ["a2", null]])
    })

    it("types an address as the storefront recorded it, else from the default flags", () => {
        expect(addressKind({ metadata: { address_type: "shipping" }, is_default_billing: true })).toBe("Shipping")
        expect(addressKind({ metadata: { address_type: "Billing" } })).toBe("Billing")
        expect(addressKind({ is_default_shipping: true, is_default_billing: false })).toBe("Shipping")
        expect(addressKind({})).toBe("Billing")
    })

    it("carries a GSTIN typed at checkout onto the order's address", () => {
        const [ship] = addressesOfOrder({
            shipping_address: { id: "oa1", address_1: "2 Test St", city: "Bengaluru", province: "Karnataka", metadata: { gstin: G } },
        })
        expect(ship).toMatchObject({ id: "oa1", kind: "Shipping", gstin: G })
    })
})
