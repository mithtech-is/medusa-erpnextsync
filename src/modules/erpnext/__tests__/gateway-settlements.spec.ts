import { describe, expect, it } from "vitest"

import type { FrappeClient, FrappeResult } from "../frappe-client"
import {
    DEFAULT_GATEWAY_SAC,
    DEFAULT_GATEWAY_SUPPLIERS,
    bookSettlementDocuments,
    buildJournalEntry,
    journalEntryDiffers,
    modeForGateway,
    normalizeGatewaySuppliers,
    parseSettlement,
    planSettlement,
    purchaseInvoiceDiffers,
    settlementConfig,
    settlementEventId,
    supplyOf,
    type Settlement,
    type SettlementContext,
    type SettlementLinks,
} from "../gateway-settlements"

describe("the gateway → supplier map", () => {
    it("defaults to Cashfree's supplier and a service item whose SAC is still to confirm", () => {
        expect(normalizeGatewaySuppliers(null)).toEqual({
            cashfree: {
                supplier: "Cashfree Payments India Private Limited",
                item: "Payment Gateway Charges",
                gst_hsn_code: "997158",
                mode_of_payment: null,
            },
        })
        expect(DEFAULT_GATEWAY_SAC).toBe("997158")
        expect(normalizeGatewaySuppliers(undefined)).toEqual(DEFAULT_GATEWAY_SUPPLIERS)
    })

    it("keeps rows with a supplier, fills the item and SAC, and lower-cases the gateway", () => {
        expect(
            normalizeGatewaySuppliers({
                Razorpay: { supplier: " Razorpay Software Pvt Ltd ", mode_of_payment: "Razorpay" },
                cashfree: { supplier: "" },
            }),
        ).toEqual({
            razorpay: {
                supplier: "Razorpay Software Pvt Ltd",
                item: "Payment Gateway Charges",
                gst_hsn_code: "997158",
                mode_of_payment: "Razorpay",
            },
        })
        expect(normalizeGatewaySuppliers("{bad")).toEqual({})
        expect(normalizeGatewaySuppliers({})).toEqual({})
    })
})

describe("the Mode of Payment a gateway was paid into", () => {
    const gateway = normalizeGatewaySuppliers(null).cashfree

    it("finds the Medusa provider id for the gateway in the provider map", () => {
        expect(modeForGateway("cashfree", gateway, { "pp_cashfree-pg": "Cashfree" })).toEqual({ ok: true, mode: "Cashfree" })
        expect(modeForGateway("cashfree", gateway, null)).toEqual({ ok: true, mode: "Cashfree" })
        expect(modeForGateway("cashfree", gateway, { cashfree: "Cashfree UPI" })).toEqual({ ok: true, mode: "Cashfree UPI" })
    })

    it("prefers the gateway's own row", () => {
        expect(modeForGateway("cashfree", { ...gateway, mode_of_payment: "CF Clearing" }, { "pp_cashfree-pg": "Cashfree" })).toEqual({
            ok: true,
            mode: "CF Clearing",
        })
    })

    it("refuses to guess between two modes, or when there is none", () => {
        const two = modeForGateway("cashfree", gateway, { "pp_cashfree-pg": "Cashfree", pp_cashfree_upi: "Cashfree UPI" })
        expect(two.ok).toBe(false)
        const none = modeForGateway("cashfree", gateway, { pp_cashfreex: "Other", "pp_razorpay-pg": "Razorpay" })
        expect(none).toEqual({ ok: false, error: "no Mode of Payment for gateway cashfree; map it under Settings → Payments into ERPNext" })
    })
})

const raw = (over: Record<string, any> = {}) => ({
    provider: "cashfree",
    settlement_id: "1209384",
    utr: "IDFB26101100123",
    settled_at: "2026-10-10T20:30:00Z",
    currency: "INR",
    gross_amount: 10000,
    fee_amount: 200,
    fee_tax_amount: 36,
    refund_amount: 0,
    adjustment_amount: 0,
    net_amount: 9764,
    lines: [
        {
            type: "payment",
            gateway_payment_id: "5114910293",
            gateway_order_id: "order_01",
            medusa_payment_id: "pay_01",
            medusa_order_id: "order_01",
            amount: 10000,
            fee_amount: 200,
            fee_tax_amount: 36,
        },
    ],
    ...over,
})
const settlementOf = (over: Record<string, any> = {}): Settlement => {
    const parsed = parseSettlement(raw(over))
    if (parsed.ok === false) throw new Error(parsed.error)
    return parsed.settlement
}

describe("reading a settlement", () => {
    it("keeps one sync row per settlement", () => {
        expect(settlementEventId(raw())).toBe("settlement:cashfree:1209384")
        expect(settlementEventId({})).toBe("settlement:unknown:unknown")
    })

    it("never reads a missing figure as zero", () => {
        expect(parseSettlement(raw({ fee_tax_amount: undefined }))).toEqual({ ok: false, error: "settlement 1209384 has no fee_tax_amount" })
        expect(parseSettlement(raw({ settled_at: "yesterday" })).ok).toBe(false)
        expect(parseSettlement(raw({ lines: null })).ok).toBe(false)
        expect(parseSettlement({ ...raw(), provider: "" }).ok).toBe(false)
    })
})

describe("whether a settlement can be booked", () => {
    it("books fee and payout on the settlement's day, the UTR as reference", () => {
        expect(planSettlement(settlementOf(), "2026-10-11")).toEqual({
            ok: true,
            fee: 200,
            feeTax: 36,
            net: 9764,
            date: "2026-10-11",
            reference: "IDFB26101100123",
            notes: [],
        })
        const noUtr = planSettlement(settlementOf({ utr: null }), "2026-10-11")
        expect(noUtr.ok && noUtr.reference).toBe("1209384")
    })

    it("nets refunds from the payout and says what a partial refund leaves behind", () => {
        const plan = planSettlement(
            settlementOf({
                refund_amount: 1000,
                net_amount: 8764,
                lines: [...raw().lines, { type: "refund", gateway_payment_id: "5114910299", amount: 1000, fee_amount: 0, fee_tax_amount: 0 }],
            }),
            "2026-10-11",
        )
        expect(plan.ok).toBe(true)
        expect(plan.ok && plan.net).toBe(8764)
        expect(plan.ok && plan.notes[0]).toContain("refunds of 1000.00 netted from the payout")
    })

    it("books nothing for a chargeback, and says why", () => {
        const plan = planSettlement(
            settlementOf({
                net_amount: 7764,
                adjustment_amount: -2000,
                lines: [...raw().lines, { type: "chargeback", gateway_payment_id: "5114910200", amount: -2000 }],
            }),
            "2026-10-11",
        )
        expect(plan.ok).toBe(false)
        expect(plan.ok === false && plan.error).toBe(
            "settlement 1209384: it carries 1 chargeback line(s) and an adjustment of -2000.00, which cannot be matched to the store's own entries; nothing was booked. Book it by hand in ERPNext, or replay once the settlement is corrected",
        )
    })

    it("books nothing for an adjustment, a foreign currency, an unknown line, or figures that do not add up", () => {
        const adj = planSettlement(settlementOf({ adjustment_amount: 50, net_amount: 9814 }), "2026-10-11")
        expect(adj.ok === false && adj.error).toContain("an adjustment of 50.00")
        const usd = planSettlement(settlementOf({ currency: "USD" }), "2026-10-11")
        expect(usd.ok === false && usd.error).toContain("currency USD")
        const odd = planSettlement(settlementOf({ lines: [{ type: "reversal", amount: 1 }] }), "2026-10-11")
        expect(odd.ok === false && odd.error).toContain("unknown type reversal")
        const sums = planSettlement(settlementOf({ net_amount: 9800 }), "2026-10-11")
        expect(sums.ok === false && sums.error).toContain("gross 10000.00 - refunds 0.00 - fee 200.00 - GST 36.00 = 9764.00, but the payout is 9800.00")
    })
})

describe("whether Settings book a gateway's settlements", () => {
    const row = { book_settlements: true, settlement_bank_account: "IDFC Current - SGPL", gateway_suppliers: null, payment_modes: null }

    it("skips every settlement while booking is off", () => {
        expect(settlementConfig({ ...row, book_settlements: false }, "cashfree")).toEqual({
            action: "skip",
            reason: "settlements are not booked (Settings → Gateway settlements into ERPNext)",
        })
        expect(settlementConfig(null, "cashfree").action).toBe("skip")
    })

    it("books with the gateway's supplier, its Mode of Payment and the bank account", () => {
        expect(settlementConfig(row, "Cashfree")).toEqual({
            action: "book",
            gateway: DEFAULT_GATEWAY_SUPPLIERS.cashfree,
            mode: "Cashfree",
            bankAccount: "IDFC Current - SGPL",
        })
    })

    it("fails a settlement it cannot place rather than guessing", () => {
        expect(settlementConfig({ ...row, settlement_bank_account: " " }, "cashfree")).toMatchObject({ action: "fail" })
        expect(settlementConfig(row, "razorpay")).toMatchObject({ action: "fail", error: expect.stringContaining("no supplier for gateway razorpay") })
        expect(settlementConfig({ ...row, payment_modes: { pp_cod: "Cash" } }, "cashfree")).toMatchObject({
            action: "fail",
            error: expect.stringContaining("no Mode of Payment for gateway cashfree"),
        })
    })
})

describe("the documents' payloads", () => {
    it("tells intra-state from inter-state by the GSTINs' state codes", () => {
        expect(supplyOf("27AAACS1234A1Z5", "27AAFCC6290C1ZB")).toBe("intra-state")
        expect(supplyOf("27AAACS1234A1Z5", "29AAFCC6290C1ZB")).toBe("inter-state")
        expect(supplyOf("27AAACS1234A1Z5", null)).toBeNull()
    })

    it("moves the payout from the clearing account to the bank, the UTR as cheque number", () => {
        expect(
            buildJournalEntry({
                company: "SG",
                date: "2026-10-11",
                reference: "IDFB26101100123",
                net: 9764,
                bankAccount: "IDFC Current - SGPL",
                clearingAccount: "Cashfree Clearing - SGPL",
                remark: "Payout of cashfree settlement 1209384, UTR IDFB26101100123",
            }),
        ).toEqual({
            doctype: "Journal Entry",
            voucher_type: "Bank Entry",
            company: "SG",
            posting_date: "2026-10-11",
            cheque_no: "IDFB26101100123",
            cheque_date: "2026-10-11",
            user_remark: "Payout of cashfree settlement 1209384, UTR IDFB26101100123",
            multi_currency: 0,
            accounts: [
                { account: "IDFC Current - SGPL", debit_in_account_currency: 9764, credit_in_account_currency: 0 },
                { account: "Cashfree Clearing - SGPL", debit_in_account_currency: 0, credit_in_account_currency: 9764 },
            ],
        })
    })

    it("compares a submitted document with what the settlement now says", () => {
        expect(purchaseInvoiceDiffers({ net_total: 200, total_taxes_and_charges: 36 }, { fee: 200, feeTax: 36.8 })).toBeNull()
        expect(purchaseInvoiceDiffers({ net_total: 200, total_taxes_and_charges: 36 }, { fee: 210, feeTax: 37.8 })).toContain("a fee of 200.00")
        expect(purchaseInvoiceDiffers({ net_total: 200, total_taxes_and_charges: 36 }, { fee: 200, feeTax: 38 })).toContain("GST of 36.00")
        const je = { accounts: [{ account: "B", debit_in_account_currency: 9764 }, { account: "C", credit_in_account_currency: 9764 }] }
        expect(journalEntryDiffers(je, { net: 9764, bankAccount: "B", clearingAccount: "C" })).toBeNull()
        expect(journalEntryDiffers(je, { net: 9700, bankAccount: "B", clearingAccount: "C" })).toContain("where the payout is now 9700.00")
    })
})

// ── Booking against a fake ERPNext ────────────────────────────────────

const ok = (data: any): FrappeResult => ({ ok: true, status: 200, data })
const notFound: FrappeResult = { ok: false, status: 404, error: "HTTP 404: not found" }

const IN_STATE = {
    taxes_and_charges: "Input GST In-state - SGPL",
    company_gstin: "27AAACS1234A1Z5",
    supplier_gstin: "27AAFCC6290C1ZB",
    supplier_address: "Cashfree-Billing",
    place_of_supply: "27-Maharashtra",
    gst_category: "Registered Regular",
    credit_to: "Creditors - SGPL",
    taxes: [
        { name: "row1", charge_type: "On Net Total", account_head: "Input Tax CGST - SGPL", rate: 9, description: "CGST" },
        { name: "row2", charge_type: "On Net Total", account_head: "Input Tax SGST - SGPL", rate: 9, description: "SGST" },
    ],
}
const OUT_STATE = {
    ...IN_STATE,
    taxes_and_charges: "Input GST Out-state - SGPL",
    supplier_gstin: "29AAFCC6290C1ZB",
    place_of_supply: "27-Maharashtra",
    taxes: [{ charge_type: "On Net Total", account_head: "Input Tax IGST - SGPL", rate: 18, description: "IGST" }],
}
const UNREGISTERED = { supplier_address: null, gst_category: "Unregistered", taxes_and_charges: "", taxes: [] }

type Call = { method: string; path: string; body?: any; query?: Record<string, string> }

/**
 * A fake ERPNext that keeps the documents it is sent and works out their
 * totals the way ERPNext would for these simple ones.
 */
function fakeErpnext(opts: { party?: any; docs?: Record<string, Record<string, any>>; supplierByTitle?: boolean } = {}) {
    const calls: Call[] = []
    const docs: Record<string, Record<string, any>> = { ...(opts.docs ?? {}) }
    const counters: Record<string, number> = {}
    const prefix: Record<string, string> = { "Purchase Invoice": "ACC-PINV-2026-", "Journal Entry": "ACC-JV-2026-" }
    const totals = (doctype: string, doc: Record<string, any>) => {
        if (doctype !== "Purchase Invoice") return doc
        const net = (doc.items ?? []).reduce((t: number, r: any) => t + Number(r.rate) * Number(r.qty ?? 1), 0)
        const tax = Math.round((doc.taxes ?? []).reduce((t: number, r: any) => t + (net * Number(r.rate)) / 100, 0) * 100) / 100
        return { ...doc, net_total: net, total_taxes_and_charges: tax, grand_total: net + tax, base_grand_total: net + tax }
    }
    const parse = (path: string) => {
        const m = /^\/api\/resource\/([^/]+)(?:\/(.+))?$/.exec(path)
        return m ? { doctype: decodeURIComponent(m[1]), name: m[2] ? decodeURIComponent(m[2]) : null } : null
    }
    const list = (doctype: string, query?: Record<string, string>) => {
        const filters: any[] = JSON.parse(query?.filters ?? "[]")
        const rows = Object.entries(docs)
            .filter(([key]) => key.startsWith(`${doctype}/`))
            .map(([, d]) => d)
            .filter((d) =>
                filters.every(([field, op, value]) =>
                    op === "=" ? d[field] === value : op === "<" ? Number(d[field] ?? 0) < value : op === "like" ? String(d[field] ?? "").includes(String(value).replace(/%/g, "")) : true,
                ),
            )
        return ok(rows.map((d) => ({ name: d.name })))
    }
    const handle = (method: string, path: string, body?: any, query?: Record<string, string>): FrappeResult => {
        if (path.endsWith("get_bank_cash_account")) return ok({ account: "Cashfree Clearing - SGPL" })
        if (path.endsWith("get_party_details")) return ok(opts.party ?? IN_STATE)
        const r = parse(path)
        if (!r) return notFound
        if (r.doctype === "Account") return r.name === "IDFC Current - SGPL" ? ok({ name: r.name, account_type: "Bank" }) : notFound
        if (r.doctype === "Supplier") {
            if (r.name) return !opts.supplierByTitle && r.name === "Cashfree Payments India Private Limited" ? ok({ name: r.name }) : notFound
            return ok(opts.supplierByTitle ? [{ name: "SUP-0007" }] : [])
        }
        const key = `${r.doctype}/${r.name}`
        if (method === "GET") return r.name ? (docs[key] ? ok(docs[key]) : notFound) : list(r.doctype, query)
        if (method === "POST") {
            counters[r.doctype] = (counters[r.doctype] ?? 0) + 1
            const name = `${prefix[r.doctype]}${String(counters[r.doctype]).padStart(5, "0")}`
            docs[`${r.doctype}/${name}`] = totals(r.doctype, { ...body, name, docstatus: 0 })
            return ok(docs[`${r.doctype}/${name}`])
        }
        if (method === "PUT" && docs[key]) {
            docs[key] = totals(r.doctype, { ...docs[key], ...body })
            return ok(docs[key])
        }
        return notFound
    }
    const client: FrappeClient = {
        async get(path, query) {
            calls.push({ method: "GET", path, query })
            return handle("GET", path, undefined, query)
        },
        async post(path, body) {
            calls.push({ method: "POST", path, body })
            return handle("POST", path, body)
        },
        async put(path, body) {
            calls.push({ method: "PUT", path, body })
            return handle("PUT", path, body)
        },
        async delete(path) {
            calls.push({ method: "DELETE", path })
            return handle("DELETE", path)
        },
    }
    const writes = () => calls.filter((c) => c.method !== "GET" && !c.path.startsWith("/api/method/")).map((c) => `${c.method} ${c.path}`)
    return { client, calls, docs, writes }
}

function linkStore(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial))
    const links: SettlementLinks = {
        get: async (doctype) => map.get(doctype) ?? null,
        record: async (doctype, name) => void map.set(doctype, name),
        drop: async (doctype) => void map.delete(doctype),
    }
    return { links, map }
}

function contextFor(over: Record<string, any> = {}, links = linkStore().links): SettlementContext {
    const settlement = settlementOf(over)
    const plan = planSettlement(settlement, "2026-10-11")
    if (plan.ok === false) throw new Error(plan.error)
    return {
        settlement,
        plan,
        gateway: DEFAULT_GATEWAY_SUPPLIERS.cashfree,
        mode: "Cashfree",
        company: "Splendx Generators Pvt Ltd",
        companyAddress: "Splendx-Billing",
        bankAccount: "IDFC Current - SGPL",
        links,
    }
}

const PI = "/api/resource/Purchase%20Invoice"
const JE = "/api/resource/Journal%20Entry"

describe("booking a settlement in ERPNext", () => {
    it("intra-state: a paid Purchase Invoice with CGST and SGST, then the payout, both submitted", async () => {
        const erp = fakeErpnext({ party: IN_STATE })
        const store = linkStore()
        const out = await bookSettlementDocuments(erp.client, contextFor({}, store.links))
        expect(out.ok).toBe(true)
        expect(out.ok && out.action).toBe("booked")

        const partyCall = erp.calls.find((c) => c.path.endsWith("get_party_details"))!
        expect(partyCall.body).toEqual({
            party: "Cashfree Payments India Private Limited",
            party_type: "Supplier",
            doctype: "Purchase Invoice",
            company: "Splendx Generators Pvt Ltd",
            posting_date: "2026-10-11",
            bill_date: "2026-10-11",
            company_address: "Splendx-Billing",
        })
        const insert = erp.calls.find((c) => c.method === "POST" && c.path === PI)!.body
        expect(insert).toMatchObject({
            doctype: "Purchase Invoice",
            company: "Splendx Generators Pvt Ltd",
            supplier: "Cashfree Payments India Private Limited",
            supplier_address: "Cashfree-Billing",
            supplier_gstin: "27AAFCC6290C1ZB",
            place_of_supply: "27-Maharashtra",
            posting_date: "2026-10-11",
            bill_no: "1209384",
            bill_date: "2026-10-11",
            is_paid: 1,
            mode_of_payment: "Cashfree",
            cash_bank_account: "Cashfree Clearing - SGPL",
            disable_rounded_total: 1,
            update_stock: 0,
            items: [{ item_code: "Payment Gateway Charges", qty: 1, rate: 200 }],
            taxes_and_charges: "Input GST In-state - SGPL",
        })
        expect(insert.credit_to).toBeUndefined()
        expect(insert.taxes).toEqual([
            { charge_type: "On Net Total", account_head: "Input Tax CGST - SGPL", rate: 9, description: "CGST" },
            { charge_type: "On Net Total", account_head: "Input Tax SGST - SGPL", rate: 9, description: "SGST" },
        ])
        expect(erp.docs[`Purchase Invoice/ACC-PINV-2026-00001`]).toMatchObject({ docstatus: 1, paid_amount: 236, total_taxes_and_charges: 36 })
        expect(erp.docs[`Journal Entry/ACC-JV-2026-00001`]).toMatchObject({
            docstatus: 1,
            cheque_no: "IDFB26101100123",
            user_remark: "Payout of cashfree settlement 1209384, UTR IDFB26101100123",
        })
        expect(erp.writes()).toEqual([
            `POST ${PI}`,
            `PUT ${PI}/ACC-PINV-2026-00001`,
            `PUT ${PI}/ACC-PINV-2026-00001`,
            `POST ${JE}`,
            `PUT ${JE}/ACC-JV-2026-00001`,
        ])
        expect(Object.fromEntries(store.map)).toEqual({ "Purchase Invoice": "ACC-PINV-2026-00001", "Journal Entry": "ACC-JV-2026-00001" })
        expect(out.ok && out.notes).toEqual([
            "Purchase Invoice ACC-PINV-2026-00001 submitted: fee 200.00, intra-state GST 36.00, 236.00 paid from Cashfree Clearing - SGPL",
            "Journal Entry ACC-JV-2026-00001 submitted: 9764.00 from Cashfree Clearing - SGPL to IDFC Current - SGPL, reference IDFB26101100123",
        ])
    })

    it("inter-state: ERPNext's IGST template lands on the invoice", async () => {
        const erp = fakeErpnext({ party: OUT_STATE })
        const out = await bookSettlementDocuments(erp.client, contextFor())
        expect(out.ok).toBe(true)
        const insert = erp.calls.find((c) => c.method === "POST" && c.path === PI)!.body
        expect(insert.taxes_and_charges).toBe("Input GST Out-state - SGPL")
        expect(insert.taxes).toEqual([{ charge_type: "On Net Total", account_head: "Input Tax IGST - SGPL", rate: 18, description: "IGST" }])
        expect(out.ok && out.notes[0]).toContain("inter-state GST 36.00")
    })

    it("keeps the invoice a draft and books no payout when ERPNext's GST differs by more than a rupee", async () => {
        const erp = fakeErpnext({ party: UNREGISTERED })
        const store = linkStore()
        const out = await bookSettlementDocuments(erp.client, contextFor({}, store.links))
        expect(out).toEqual({
            ok: false,
            error:
                "Purchase Invoice ACC-PINV-2026-00001 kept as a draft: ERPNext's GST on the fee is 0.00 but the settlement charged 36.00. " +
                "Check the supplier's GSTIN and address (India Compliance picks the purchase taxes from them) and the item's tax template, then replay this event",
        })
        expect(erp.writes()).toEqual([`POST ${PI}`])
        expect(erp.docs["Purchase Invoice/ACC-PINV-2026-00001"].docstatus).toBe(0)
        expect(store.map.get("Purchase Invoice")).toBe("ACC-PINV-2026-00001")
    })

    it("a replay after the supplier is fixed updates the same draft rather than making another", async () => {
        const erp = fakeErpnext({ party: UNREGISTERED })
        const store = linkStore()
        await bookSettlementDocuments(erp.client, contextFor({}, store.links))
        const fixed = fakeErpnext({ party: IN_STATE, docs: erp.docs })
        const out = await bookSettlementDocuments(fixed.client, contextFor({}, store.links))
        expect(out.ok).toBe(true)
        expect(fixed.writes().slice(0, 1)).toEqual([`PUT ${PI}/ACC-PINV-2026-00001`])
        expect(fixed.writes()).not.toContain(`POST ${PI}`)
        expect(fixed.docs["Purchase Invoice/ACC-PINV-2026-00001"]).toMatchObject({ docstatus: 1, total_taxes_and_charges: 36 })
    })

    it("books nothing twice: a replay finds both documents submitted and writes nothing", async () => {
        const erp = fakeErpnext()
        const store = linkStore()
        await bookSettlementDocuments(erp.client, contextFor({}, store.links))
        const again = fakeErpnext({ docs: erp.docs })
        const out = await bookSettlementDocuments(again.client, contextFor({}, store.links))
        expect(out).toEqual({
            ok: true,
            action: "unchanged",
            notes: ["Purchase Invoice ACC-PINV-2026-00001 for the fee already submitted", "Journal Entry ACC-JV-2026-00001 for the payout already submitted"],
        })
        expect(again.writes()).toEqual([])
    })

    it("finds documents an attempt made before its links were recorded", async () => {
        const erp = fakeErpnext()
        await bookSettlementDocuments(erp.client, contextFor())
        const store = linkStore()
        const again = fakeErpnext({ docs: erp.docs })
        const out = await bookSettlementDocuments(again.client, contextFor({}, store.links))
        expect(out.ok && out.action).toBe("unchanged")
        expect(again.writes()).toEqual([])
        expect(Object.fromEntries(store.map)).toEqual({ "Purchase Invoice": "ACC-PINV-2026-00001", "Journal Entry": "ACC-JV-2026-00001" })
        const piQuery = again.calls.find((c) => c.method === "GET" && c.path === PI)!
        expect(JSON.parse(piQuery.query!.filters)).toEqual([
            ["supplier", "=", "Cashfree Payments India Private Limited"],
            ["bill_no", "=", "1209384"],
            ["docstatus", "<", 2],
        ])
    })

    it("a re-emitted settlement with new figures updates drafts in place", async () => {
        const docs = {
            "Purchase Invoice/ACC-PINV-2026-00001": { name: "ACC-PINV-2026-00001", docstatus: 0, items: [{ rate: 200, qty: 1 }], taxes: [], net_total: 200, total_taxes_and_charges: 0 },
            "Journal Entry/ACC-JV-2026-00001": { name: "ACC-JV-2026-00001", docstatus: 0, accounts: [] },
        }
        const erp = fakeErpnext({ docs })
        const store = linkStore({ "Purchase Invoice": "ACC-PINV-2026-00001", "Journal Entry": "ACC-JV-2026-00001" })
        const out = await bookSettlementDocuments(erp.client, contextFor({ fee_amount: 250, fee_tax_amount: 45, net_amount: 9705 }, store.links))
        expect(out.ok).toBe(true)
        const piPut = erp.calls.find((c) => c.method === "PUT" && c.path === `${PI}/ACC-PINV-2026-00001`)!.body
        expect(piPut.items).toEqual([{ item_code: "Payment Gateway Charges", qty: 1, rate: 250 }])
        expect(piPut.doctype).toBeUndefined()
        expect(erp.docs["Purchase Invoice/ACC-PINV-2026-00001"]).toMatchObject({ docstatus: 1, paid_amount: 295 })
        expect(erp.docs["Journal Entry/ACC-JV-2026-00001"].accounts[0]).toEqual({
            account: "IDFC Current - SGPL",
            debit_in_account_currency: 9705,
            credit_in_account_currency: 0,
        })
        expect(erp.writes()).not.toContain(`POST ${PI}`)
        expect(erp.writes()).not.toContain(`POST ${JE}`)
    })

    it("a re-emitted settlement with new figures fails against submitted documents and cancels nothing", async () => {
        const erp = fakeErpnext()
        const store = linkStore()
        await bookSettlementDocuments(erp.client, contextFor({}, store.links))
        const again = fakeErpnext({ docs: erp.docs })
        const out = await bookSettlementDocuments(again.client, contextFor({ fee_amount: 250, fee_tax_amount: 45, net_amount: 9705 }, store.links))
        expect(out).toEqual({
            ok: false,
            error:
                "Purchase Invoice ACC-PINV-2026-00001 for settlement 1209384 is submitted with a fee of 200.00 where the settlement now says 250.00; cancel and amend it in ERPNext, then replay this event",
        })
        expect(again.writes()).toEqual([])

        const payoutOnly = await bookSettlementDocuments(again.client, contextFor({ gross_amount: 10100, net_amount: 9864 }, store.links))
        expect(payoutOnly.ok).toBe(false)
        expect(payoutOnly.ok === false && payoutOnly.error).toContain("Journal Entry ACC-JV-2026-00001 for settlement 1209384 is submitted with 9764.00 into IDFC Current - SGPL")
        expect(again.writes()).toEqual([])
    })

    it("leaves a document cancelled in ERPNext alone", async () => {
        const docs = { "Journal Entry/ACC-JV-2026-00009": { name: "ACC-JV-2026-00009", docstatus: 2 } }
        const erp = fakeErpnext({ docs })
        const out = await bookSettlementDocuments(erp.client, contextFor({}, linkStore({ "Journal Entry": "ACC-JV-2026-00009" }).links))
        expect(out.ok && out.notes).toContain("Journal Entry ACC-JV-2026-00009 for the payout is cancelled in ERPNext; not made again")
        expect(erp.writes()).not.toContain(`POST ${JE}`)
    })

    it("writes nothing when the bank account or the supplier is missing", async () => {
        const erp = fakeErpnext()
        const noBank = await bookSettlementDocuments(erp.client, { ...contextFor(), bankAccount: "HDFC Current - SGPL" })
        expect(noBank).toEqual({
            ok: false,
            error: "settlement bank account HDFC Current - SGPL is not in ERPNext; create it, or let Set up ERPNext create it",
        })
        const noSupplier = await bookSettlementDocuments(erp.client, {
            ...contextFor(),
            gateway: { ...DEFAULT_GATEWAY_SUPPLIERS.cashfree, supplier: "Razorpay Software Pvt Ltd" },
        })
        expect(noSupplier).toEqual({ ok: false, error: "Supplier Razorpay Software Pvt Ltd is not in ERPNext; run Set up ERPNext or create it" })
        const same = await bookSettlementDocuments(erp.client, { ...contextFor(), bankAccount: "Cashfree Clearing - SGPL" })
        expect(same.ok).toBe(false)
        expect(erp.writes()).toEqual([])
    })

    it("finds a supplier named by series through its supplier_name", async () => {
        const erp = fakeErpnext({ supplierByTitle: true })
        const out = await bookSettlementDocuments(erp.client, contextFor())
        expect(out.ok).toBe(true)
        expect(erp.calls.find((c) => c.method === "POST" && c.path === PI)!.body.supplier).toBe("SUP-0007")
    })

    it("books only the payout when the gateway charged nothing", async () => {
        const erp = fakeErpnext()
        const out = await bookSettlementDocuments(erp.client, contextFor({ fee_amount: 0, fee_tax_amount: 0, net_amount: 10000 }))
        expect(out.ok && out.notes).toEqual([
            "no gateway charges to invoice",
            "Journal Entry ACC-JV-2026-00001 submitted: 10000.00 from Cashfree Clearing - SGPL to IDFC Current - SGPL, reference IDFB26101100123",
        ])
        expect(erp.writes()).toEqual([`POST ${JE}`, `PUT ${JE}/ACC-JV-2026-00001`])
    })
})
