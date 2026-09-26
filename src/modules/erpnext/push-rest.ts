import { formatInZone } from "./mapping-engine"

/**
 * Medusa → ERPNext over plain Frappe REST: what a Customer, an Address, a
 * Sales Order and a Sales Invoice look like when the store writes them.
 *
 * Everything here is pure. The service resolves names (which Customer,
 * which Item, which Address) through the link table and hands the
 * results in; these functions only shape documents and decide rules, so
 * the shapes can be tested without ERPNext.
 *
 * Money is in the currency's major unit throughout: Medusa 2 stores
 * amounts as decimals (an order line at 1499 is ₹1,499), and ERPNext
 * books the same figure.
 */

export type PushDefaults = {
    /** ERPNext Company the documents belong to. */
    company: string | null
    /** Selling price list on sales documents. */
    priceList: string | null
    customerGroup?: string | null
    territory?: string | null
    /** Account head that books shipping as an "Actual" charge. Without it
     *  shipping is not booked and the sync row says so. */
    shippingAccount?: string | null
    /** Sales Taxes and Charges Template applied to sales documents. */
    taxesTemplate?: string | null
}

/** Does the target DocType have this field? Custom fields included. */
export type HasField = (fieldname: string) => boolean

export function money(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n)) return 0
    return Math.round(n * 100) / 100
}

// ── Customer ─────────────────────────────────────────────────────────

export function customerDisplayName(record: any): string {
    const person = [record?.first_name, record?.last_name].filter(Boolean).join(" ").trim()
    return (
        String(record?.company_trade_name ?? "").trim() ||
        String(record?.company_name ?? "").trim() ||
        person ||
        String(record?.email ?? "").trim()
    )
}

/**
 * The Customer document: whatever the mapping produced, with the
 * mandatory and the well-known fields filled from the record when the
 * mapping left them out. A mapped value always wins.
 */
export function buildCustomerDoc(args: {
    record: any
    mapped: Record<string, any>
    has: HasField
    defaults: PushDefaults
}): Record<string, any> {
    const { record, has, defaults } = args
    const doc: Record<string, any> = { ...args.mapped }
    if (!doc.customer_name) doc.customer_name = customerDisplayName(record)
    if (!doc.customer_type) {
        doc.customer_type = record?.company_name || record?.company_trade_name || record?.gstin ? "Company" : "Individual"
    }
    if (has("email_id") && doc.email_id === undefined && record?.email) doc.email_id = String(record.email).toLowerCase()
    if (has("mobile_no") && doc.mobile_no === undefined && record?.phone) doc.mobile_no = record.phone
    if (has("gstin") && doc.gstin === undefined && record?.gstin) doc.gstin = record.gstin
    if (has("gst_category") && doc.gst_category === undefined) {
        doc.gst_category = doc.gstin || record?.gstin ? "Registered Regular" : "Unregistered"
    }
    if (has("customer_group") && doc.customer_group === undefined && defaults.customerGroup) {
        doc.customer_group = defaults.customerGroup
    }
    if (has("territory") && doc.territory === undefined && defaults.territory) doc.territory = defaults.territory
    return doc
}

// ── Addresses ────────────────────────────────────────────────────────

export type AddressInput = {
    /** Stable id on the Medusa side: the address id, or `company:<id>`. */
    id: string
    kind: "Billing" | "Shipping"
    title?: string | null
    line1?: string | null
    line2?: string | null
    city?: string | null
    state?: string | null
    postal_code?: string | null
    country_code?: string | null
    phone?: string | null
    email?: string | null
    gstin?: string | null
}

function addressFrom(a: any, kind: "Billing" | "Shipping", id: string, extra: Partial<AddressInput> = {}): AddressInput {
    return {
        id,
        kind,
        title: a?.company || [a?.first_name, a?.last_name].filter(Boolean).join(" ") || null,
        line1: a?.address_1 ?? a?.line1 ?? null,
        line2: a?.address_2 ?? a?.line2 ?? null,
        city: a?.city ?? null,
        state: a?.province ?? a?.state ?? null,
        postal_code: a?.postal_code ?? null,
        country_code: a?.country_code ?? null,
        phone: a?.phone ?? null,
        ...extra,
    }
}

/** A customer's addresses: its own, and the company's GST-registered
 *  billing address when there is one (that is the invoice address). */
export function addressesOfCustomer(record: any): AddressInput[] {
    const out: AddressInput[] = []
    for (const a of Array.isArray(record?.addresses) ? record.addresses : []) {
        if (!a?.id) continue
        out.push(addressFrom(a, a.is_default_shipping && !a.is_default_billing ? "Shipping" : "Billing", String(a.id)))
    }
    const cba = record?.company_billing_address
    if (cba && (cba.line1 || cba.address_1)) {
        out.push(
            addressFrom(cba, "Billing", `company:${record.company_id_resolved ?? record.company_id ?? "billing"}`, {
                title: record.company_trade_name || record.company_name || "Company billing",
                gstin: record.gstin ?? null,
            }),
        )
    }
    return out
}

/** An order's billing and shipping addresses, keyed by their own ids. */
export function addressesOfOrder(order: any): AddressInput[] {
    const out: AddressInput[] = []
    if (order?.billing_address?.id) out.push(addressFrom(order.billing_address, "Billing", String(order.billing_address.id)))
    if (order?.shipping_address?.id) out.push(addressFrom(order.shipping_address, "Shipping", String(order.shipping_address.id)))
    return out
}

/**
 * The Address document. ERPNext needs a line, a city and a Country by
 * name; an address missing one is reported, not sent half-made.
 */
export function buildAddressDoc(args: {
    input: AddressInput
    customerName: string
    /** The Country record's name for the input's ISO code, or null. */
    countryName: string | null
    has: HasField
}): { ok: true; doc: Record<string, any> } | { ok: false; reason: string } {
    const { input, customerName, countryName, has } = args
    const line1 = String(input.line1 ?? "").trim()
    const city = String(input.city ?? "").trim()
    if (!line1) return { ok: false, reason: "address has no first line" }
    if (!city) return { ok: false, reason: "address has no city" }
    if (!countryName) return { ok: false, reason: `no ERPNext Country for code "${input.country_code ?? ""}"` }
    const doc: Record<string, any> = {
        address_title: String(input.title ?? "").trim() || customerName,
        address_type: input.kind,
        address_line1: line1,
        address_line2: input.line2 || null,
        city,
        state: input.state || null,
        pincode: input.postal_code || null,
        country: countryName,
        phone: input.phone || null,
        email_id: input.email || null,
        links: [{ link_doctype: "Customer", link_name: customerName }],
    }
    if (has("gstin") && input.gstin) doc.gstin = input.gstin
    if (has("gst_category")) doc.gst_category = input.gstin ? "Registered Regular" : "Unregistered"
    return { ok: true, doc }
}

// ── Sales documents ──────────────────────────────────────────────────

export type OrderTotals = { subtotal: number; tax: number; shipping: number; discount: number; grand: number }

/**
 * What the order adds up to. The line rates are the unit prices, tax is
 * the lines' tax, and whatever the grand total has beyond those is
 * shipping (when positive) or a discount (when negative), so ERPNext's
 * grand total reconciles to Medusa's exactly.
 */
export function orderTotals(order: any): OrderTotals {
    const items = Array.isArray(order?.items) ? order.items : []
    const subtotal = money(items.reduce((s: number, li: any) => s + money(li?.unit_price) * (Number(li?.quantity) || 1), 0))
    const tax = money(items.reduce((s: number, li: any) => s + money(li?.tax_total), 0))
    const grand = money(order?.total)
    const shippingKnown = order?.shipping_total != null ? money(order.shipping_total) : null
    const discountKnown = order?.discount_total != null ? money(order.discount_total) : null
    const residual = money(grand - subtotal - tax)
    const shipping = shippingKnown ?? Math.max(0, residual)
    const discount = discountKnown ?? Math.max(0, -residual)
    return { subtotal, tax, shipping, discount, grand }
}

export type SalesOrderBuild =
    | { ok: true; doc: Record<string, any>; notes: string[] }
    | { ok: false; reason: string; missing: string[] }

/**
 * The Sales Order. Every line needs an ERPNext Item; a line without one
 * stops the document, naming the lines, rather than shipping an order
 * short. Dates are the site's; delivery is a week out, which is what
 * ERPNext insists on having and what the old app chose too.
 */
export function buildSalesOrderDoc(args: {
    order: any
    customerName: string
    itemCodeFor: (line: any) => string | null
    addresses: { billing?: string | null; shipping?: string | null }
    defaults: PushDefaults
    has: HasField
    timezone?: string | null
}): SalesOrderBuild {
    const { order, customerName, defaults, has } = args
    const items = Array.isArray(order?.items) ? order.items : []
    if (!items.length) return { ok: false, reason: "order has no line items", missing: [] }
    const missing: string[] = []
    const lines: any[] = []
    const placed = order?.created_at ? new Date(order.created_at) : new Date()
    const transaction_date = formatInZone(placed, args.timezone, false)
    const delivery_date = formatInZone(new Date(placed.getTime() + 7 * 24 * 3600 * 1000), args.timezone, false)
    for (const li of items) {
        const code = args.itemCodeFor(li)
        if (!code) {
            missing.push(String(li?.variant?.sku ?? li?.title ?? li?.id ?? "?"))
            continue
        }
        lines.push({
            item_code: code,
            item_name: li?.title ?? li?.variant?.product?.title ?? code,
            qty: Number(li?.quantity) || 1,
            rate: money(li?.unit_price),
            delivery_date,
        })
    }
    if (missing.length) {
        return { ok: false, reason: `no ERPNext Item for: ${missing.join(", ")}`, missing }
    }
    const totals = orderTotals(order)
    const currency = String(order?.currency_code ?? "").toUpperCase() || undefined
    const notes: string[] = []
    const doc: Record<string, any> = {
        customer: customerName,
        order_type: "Sales",
        transaction_date,
        delivery_date,
        po_no: order?.display_id != null ? `#${order.display_id}` : undefined,
        currency,
        conversion_rate: 1,
        price_list_currency: currency,
        plc_conversion_rate: 1,
        items: lines,
    }
    if (defaults.company) doc.company = defaults.company
    if (defaults.priceList) doc.selling_price_list = defaults.priceList
    if (args.addresses.billing) doc.customer_address = args.addresses.billing
    if (args.addresses.shipping) doc.shipping_address_name = args.addresses.shipping
    if (defaults.taxesTemplate) doc.taxes_and_charges = defaults.taxesTemplate
    if (totals.shipping > 0) {
        if (defaults.shippingAccount) {
            doc.taxes = [
                {
                    charge_type: "Actual",
                    account_head: defaults.shippingAccount,
                    description: "Shipping",
                    tax_amount: totals.shipping,
                },
            ]
        } else {
            notes.push(`shipping ${totals.shipping} not booked: no shipping account configured`)
        }
    }
    if (totals.discount > 0) {
        doc.apply_discount_on = "Grand Total"
        doc.discount_amount = totals.discount
    }
    if (has("medusa_order_id") && order?.id) doc.medusa_order_id = order.id
    return { ok: true, doc, notes }
}

/** Has the order been paid in full? Captured payments cover the total,
 *  or Medusa already says so. */
export function orderFullyPaid(order: any): boolean {
    if (String(order?.payment_status ?? "").toLowerCase() === "captured") return true
    const paid = (Array.isArray(order?.payments) ? order.payments : []).reduce(
        (s: number, p: any) => s + money(p?.amount),
        0,
    )
    const grand = money(order?.total)
    return grand > 0 && paid >= grand - 0.01
}

/** What the store wants an order to become. Unset means both. */
export function wantsSalesOrder(orderDocument: string | null | undefined): boolean {
    const v = String(orderDocument ?? "")
    return !v || v.includes("Sales Order")
}
export function wantsSalesInvoice(orderDocument: string | null | undefined): boolean {
    const v = String(orderDocument ?? "")
    return !v || v.includes("Sales Invoice")
}

/**
 * Is this document, arriving from ERPNext, our own write coming home?
 * A REST write leaves the API user as `modified_by`; applying it back
 * would only bounce it again.
 */
export function isOwnWrite(doc: any, apiUser: string | null | undefined): boolean {
    if (!apiUser) return false
    return String(doc?.modified_by ?? "").toLowerCase() === String(apiUser).toLowerCase()
}

/** The value a document created by a push carries in `medusa_sync`. */
export function directionForCreated(mappingDirection: string | null | undefined): "Medusa → ERPNext" | "Both" {
    return String(mappingDirection ?? "").toLowerCase() === "both" ? "Both" : "Medusa → ERPNext"
}

// ── What the transport fills on its own ──────────────────────────────

/**
 * Mandatory fields the push fills without a pair, so a rehearsal does not
 * ask the operator to map them. A Customer's name, type and contact come
 * from the record; a sales document's dates, currency, lines and party
 * come from the order. The settings-backed ones count only when the
 * setting (or the ERPNext default it falls back to) is present, because
 * that is the only case the push actually sends them.
 */
export function transportFilledFields(doctype: string, defaults: Partial<PushDefaults>): Set<string> {
    const out = new Set<string>()
    if (doctype === "Customer") {
        for (const f of ["naming_series", "customer_name", "customer_type", "email_id", "mobile_no", "gstin", "gst_category"]) out.add(f)
        if (defaults.customerGroup) out.add("customer_group")
        if (defaults.territory) out.add("territory")
    }
    if (doctype === "Sales Order" || doctype === "Sales Invoice") {
        for (const f of [
            "naming_series",
            "customer",
            "customer_name",
            "order_type",
            "transaction_date",
            "delivery_date",
            "posting_date",
            "posting_time",
            "due_date",
            "currency",
            "conversion_rate",
            "price_list_currency",
            "plc_conversion_rate",
            "selling_price_list",
            "items",
            "po_no",
            "customer_address",
            "shipping_address_name",
            "contact_email",
            "debit_to",
            "against_income_account",
        ]) out.add(f)
        if (defaults.company) out.add("company")
        if (defaults.taxesTemplate) out.add("taxes_and_charges")
    }
    return out
}
