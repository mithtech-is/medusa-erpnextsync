import { describe, expect, it } from "vitest"
import type { FrappeClient, FrappeResult } from "../frappe-client"
import {
    ON_TRASH_CONDITION,
    ON_UPDATE_CONDITION,
    buildCustomField,
    buildInvoiceWebhooks,
    buildPriceWebhooks,
    buildStockWebhooks,
    buildWebhook,
    customFieldName,
    ensureCustomField,
    ensureWebhook,
    fingerprintOf,
    inboundUrl,
    ensureSettlementMasters,
    runErpnextSetup,
    webhookJsonTemplate,
    webhookName,
    webhookUpdatePayload,
} from "../erpnext-setup"

describe("what Set up ERPNext creates", () => {
    it("names things the same way every time", () => {
        expect(customFieldName("Item")).toBe("Item-medusa_sync")
        expect(webhookName("Item", "on_update")).toBe("Medusa Sync: Item on_update")
        expect(inboundUrl("https://shop.example.com/")).toBe("https://shop.example.com/webhooks/erpnext-inbound")
    })

    it("a Select field of None and the three directions, whose default follows the mode", () => {
        const allow = buildCustomField("Item", "allow")
        expect(allow).toMatchObject({
            dt: "Item",
            fieldname: "medusa_sync",
            label: "Sync to Medusa",
            fieldtype: "Select",
            options: "None\nERPNext → Medusa\nMedusa → ERPNext\nBoth",
            default: "None",
            insert_after: "disabled",
            in_standard_filter: 1,
        })
        expect(buildCustomField("Item", "deny").default).toBe("Both")
        expect(buildCustomField("Website Item", "allow").insert_after).toBe("append")
    })

    it("a JSON body carrying the event and the whole document", () => {
        expect(webhookJsonTemplate("on_update")).toBe(
            '{"event":"on_update","doctype":{{ doc.doctype | json }},"name":{{ doc.name | json }},"doc":{{ doc | json }}}',
        )
        // Frappe rejects any template containing ".__".
        expect(webhookJsonTemplate("on_trash")).not.toContain(".__")
    })

    it("conditions that fire for a document that moves, or moved, ERPNext → Medusa, or whose field changed", () => {
        const tuple = '("ERPNext → Medusa", "Both")'
        expect(ON_UPDATE_CONDITION).toBe(
            `doc.get("medusa_sync") in ${tuple} or (doc.get_doc_before_save() and (doc.get_doc_before_save().get("medusa_sync") in ${tuple} or doc.get("medusa_sync") != doc.get_doc_before_save().get("medusa_sync")))`,
        )
        expect(ON_TRASH_CONDITION).toBe(`doc.get("medusa_sync") in ${tuple}`)
    })

    it("signed webhooks with the Content-Type header Frappe would otherwise omit", () => {
        const wh = buildWebhook({ doctype: "Item", event: "on_trash", publicUrl: "http://localhost:9019", secret: "s3cret" })
        expect(wh).toMatchObject({
            name: "Medusa Sync: Item on_trash",
            webhook_doctype: "Item",
            webhook_docevent: "on_trash",
            enabled: 1,
            request_url: "http://localhost:9019/webhooks/erpnext-inbound",
            request_method: "POST",
            request_structure: "JSON",
            condition: ON_TRASH_CONDITION,
            enable_security: 1,
            webhook_secret: "s3cret",
            timeout: 15,
        })
        expect(wh.webhook_headers).toEqual([{ doctype: "Webhook Header", key: "Content-Type", value: "application/json" }])
        expect(wh.webhook_json).toBe(webhookJsonTemplate("on_trash"))
    })

    it("never sends the set-once fields to an existing webhook", () => {
        const wh = buildWebhook({ doctype: "Item", event: "on_update", publicUrl: "http://x", secret: "s" })
        const patch = webhookUpdatePayload(wh)
        expect(patch).not.toHaveProperty("name")
        expect(patch).not.toHaveProperty("webhook_doctype")
        expect(patch).not.toHaveProperty("webhook_docevent")
        expect(patch).not.toHaveProperty("doctype")
        expect(patch.webhook_secret).toBe("s")
    })

    it("fingerprints the secret along with everything else, in any key order", () => {
        const a = buildWebhook({ doctype: "Item", event: "on_update", publicUrl: "http://x", secret: "one" })
        const b = buildWebhook({ doctype: "Item", event: "on_update", publicUrl: "http://x", secret: "two" })
        expect(fingerprintOf(a)).not.toBe(fingerprintOf(b))
        expect(fingerprintOf({ x: 1, y: [{ b: 2, a: 1 }] })).toBe(fingerprintOf({ y: [{ a: 1, b: 2 }], x: 1 }))
    })
})

/** A fake ERPNext: a map of GET answers and a log of writes. */
function fakeClient(gets: Record<string, FrappeResult>, writes: Array<{ method: string; path: string; body: any }> = []) {
    const client: FrappeClient = {
        async get(path) {
            return gets[path] ?? { ok: false, status: 404, error: "HTTP 404: not found" }
        },
        async post(path, body) {
            writes.push({ method: "POST", path, body })
            return { ok: true, status: 200, data: body }
        },
        async put(path, body) {
            writes.push({ method: "PUT", path, body })
            return { ok: true, status: 200, data: body }
        },
        async delete(path) {
            writes.push({ method: "DELETE", path, body: null })
            return { ok: true, status: 202, data: null }
        },
    }
    return { client, writes }
}

describe("making ERPNext match", () => {
    it("creates what is missing", async () => {
        const { client, writes } = fakeClient({})
        const item = await ensureCustomField(client, "Item", "allow")
        expect(item.action).toBe("created")
        expect(writes[0]).toMatchObject({ method: "POST", path: "/api/resource/Custom%20Field" })
        expect(writes[0].body.fieldname).toBe("medusa_sync")
    })

    it("leaves a field that already says the right thing alone, and updates one that drifted", async () => {
        const desired = buildCustomField("Item", "allow")
        const same = fakeClient({
            "/api/resource/Custom%20Field/Item-medusa_sync": { ok: true, status: 200, data: { ...desired, insert_after: "disabled" } },
        })
        expect((await ensureCustomField(same.client, "Item", "allow")).action).toBe("unchanged")
        expect(same.writes).toHaveLength(0)

        const drifted = fakeClient({
            "/api/resource/Custom%20Field/Item-medusa_sync": { ok: true, status: 200, data: { ...desired, default: "Both" } },
        })
        const item = await ensureCustomField(drifted.client, "Item", "allow")
        expect(item.action).toBe("updated")
        expect(drifted.writes[0]).toMatchObject({ method: "PUT", body: { default: "None" } })
        expect(drifted.writes[0].body).not.toHaveProperty("insert_after")
    })

    it("refuses a field of another type rather than overwrite it", async () => {
        const { client } = fakeClient({
            "/api/resource/Custom%20Field/Item-medusa_sync": { ok: true, status: 200, data: { fieldtype: "Check" } },
        })
        const item = await ensureCustomField(client, "Item", "allow")
        expect(item.action).toBe("error")
        expect(item.error).toMatch(/fieldtype Check/)
    })

    it("says what a 403 means", async () => {
        const { client } = fakeClient({
            "/api/resource/Custom%20Field/Item-medusa_sync": { ok: false, status: 403, error: "HTTP 403: Not permitted" },
        })
        const item = await ensureCustomField(client, "Item", "allow")
        expect(item).toMatchObject({ action: "error", error: expect.stringMatching(/System Manager/) })
    })

    it("treats a webhook as unchanged only when the row matches AND the secret fingerprint is the one we sent last", async () => {
        const desired = buildWebhook({ doctype: "Item", event: "on_update", publicUrl: "http://x", secret: "s" })
        const onWire = { ...desired, webhook_secret: "*******" }
        const same = fakeClient({ "/api/resource/Webhook/Medusa%20Sync%3A%20Item%20on_update": { ok: true, status: 200, data: onWire } })
        const prev = { kind: "webhook" as const, doctype: "Item", name: desired.name, action: "created" as const, fingerprint: fingerprintOf(desired) }
        expect((await ensureWebhook(same.client, desired, prev)).action).toBe("unchanged")
        expect(same.writes).toHaveLength(0)

        const rotated = fakeClient({ "/api/resource/Webhook/Medusa%20Sync%3A%20Item%20on_update": { ok: true, status: 200, data: onWire } })
        const item = await ensureWebhook(rotated.client, desired, { ...prev, fingerprint: "stale" })
        expect(item.action).toBe("updated")
        expect(rotated.writes[0]).toMatchObject({ method: "PUT" })
        expect(rotated.writes[0].body).not.toHaveProperty("webhook_docevent")
    })

    it("refuses a webhook name that belongs to another doctype or event", async () => {
        const desired = buildWebhook({ doctype: "Item", event: "on_update", publicUrl: "http://x", secret: "s" })
        const { client } = fakeClient({
            "/api/resource/Webhook/Medusa%20Sync%3A%20Item%20on_update": {
                ok: true,
                status: 200,
                data: { ...desired, webhook_docevent: "after_insert" },
            },
        })
        const item = await ensureWebhook(client, desired, null)
        expect(item.action).toBe("error")
        expect(item.error).toMatch(/after_insert/)
    })

    it("runs field first, then both webhooks, per doctype, and reports every item", async () => {
        const { client, writes } = fakeClient({})
        const report = await runErpnextSetup({
            client,
            doctypes: [{ doctype: "Item", mode: "allow" }],
            publicUrl: "http://localhost:9019/",
            secret: "s",
        })
        expect(report.ok).toBe(true)
        expect(report.inbound_url).toBe("http://localhost:9019/webhooks/erpnext-inbound")
        expect(report.items.map((i) => [i.kind, i.name, i.action])).toEqual([
            ["custom_field", "Item-medusa_sync", "created"],
            ["webhook", "Medusa Sync: Item on_update", "created"],
            ["webhook", "Medusa Sync: Item on_trash", "created"],
        ])
        expect(writes.map((w) => w.path)).toEqual([
            "/api/resource/Custom%20Field",
            "/api/resource/Webhook",
            "/api/resource/Webhook",
        ])
    })

    it("does not install webhooks for a doctype whose field failed", async () => {
        const { client, writes } = fakeClient({
            "/api/resource/Custom%20Field/Item-medusa_sync": { ok: false, status: 403, error: "HTTP 403" },
        })
        const report = await runErpnextSetup({ client, doctypes: [{ doctype: "Item", mode: "allow" }], publicUrl: "http://x", secret: "s" })
        expect(report.ok).toBe(false)
        expect(report.items.every((i) => i.action === "error")).toBe(true)
        expect(writes).toHaveLength(0)
    })
})

describe("stock and price webhooks", () => {
    it("build one ledger and two order webhooks for the warehouse, and two for the price list", () => {
        const stock = buildStockWebhooks({ warehouse: "Stores - F", publicUrl: "http://x", secret: "s" })
        expect(stock.map((w) => [w.webhook_doctype, w.webhook_docevent, w.condition])).toEqual([
            ["Stock Ledger Entry", "after_insert", 'doc.warehouse == "Stores - F"'],
            ["Sales Order", "on_submit", ""],
            ["Sales Order", "on_cancel", ""],
        ])
        const prices = buildPriceWebhooks({ priceList: "Standard Selling", publicUrl: "http://x", secret: "s" })
        expect(prices.map((w) => [w.name, w.condition])).toEqual([
            ["Medusa Sync: Item Price on_update", 'doc.price_list == "Standard Selling" and doc.selling == 1'],
            ["Medusa Sync: Item Price on_trash", 'doc.price_list == "Standard Selling" and doc.selling == 1'],
        ])
        for (const w of [...stock, ...prices]) {
            expect(w.request_url).toBe("http://x/webhooks/erpnext-inbound")
            expect(w.enable_security).toBe(1)
            expect(w.webhook_json).toContain(`"event":"${w.webhook_docevent}"`)
        }
    })

    it("are created by the setup only when asked for", async () => {
        const { client, writes } = fakeClient({})
        const report = await runErpnextSetup({
            client,
            doctypes: [{ doctype: "Item", mode: "allow" }],
            publicUrl: "http://x",
            secret: "s",
            stock: { warehouse: "Stores - F" },
            prices: null,
        })
        const names = report.items.filter((i) => i.kind === "webhook").map((i) => i.name)
        expect(names).toEqual([
            "Medusa Sync: Item on_update",
            "Medusa Sync: Item on_trash",
            "Medusa Sync: Stock Ledger Entry after_insert",
            "Medusa Sync: Sales Order on_submit",
            "Medusa Sync: Sales Order on_cancel",
        ])
        expect(writes.filter((w) => w.method === "POST" && w.path.includes("Webhook"))).toHaveLength(5)
        expect(report.ok).toBe(true)
    })
})

describe("secondary DocType webhooks", () => {
    it("get one unconditioned on_update webhook each, never for a DocType already under selection", async () => {
        const { client, writes } = fakeClient({})
        const report = await runErpnextSetup({
            client,
            doctypes: [{ doctype: "Item", mode: "allow" }],
            publicUrl: "http://x",
            secret: "s",
            secondaries: ["Contact", "Item", "Contact", ""],
        })
        const names = report.items.filter((i) => i.kind === "webhook").map((i) => i.name)
        expect(names).toEqual(["Medusa Sync: Item on_update", "Medusa Sync: Item on_trash", "Medusa Sync: Contact on_update"])
        const contact = writes.find((w) => w.method === "POST" && w.body?.name === "Medusa Sync: Contact on_update")
        expect(contact?.body?.condition).toBe("")
        expect(contact?.body?.webhook_docevent).toBe("on_update")
    })
})

describe("invoice webhooks", () => {
    it("fire on a Sales Invoice's submit and cancel, unconditioned", () => {
        const hooks = buildInvoiceWebhooks({ publicUrl: "http://x", secret: "s" })
        expect(hooks.map((w) => [w.name, w.webhook_docevent, w.condition])).toEqual([
            ["Medusa Sync: Sales Invoice on_submit", "on_submit", ""],
            ["Medusa Sync: Sales Invoice on_cancel", "on_cancel", ""],
        ])
        for (const w of hooks) expect(w.request_url).toBe("http://x/webhooks/erpnext-inbound")
    })

    it("are installed only when customers are sent ERPNext's invoices", async () => {
        const off = fakeClient({})
        await runErpnextSetup({ client: off.client, doctypes: [], publicUrl: "http://x", secret: "s" })
        expect(off.writes.some((w) => String(w.body?.webhook_doctype) === "Sales Invoice")).toBe(false)
        const on = fakeClient({})
        await runErpnextSetup({ client: on.client, doctypes: [], publicUrl: "http://x", secret: "s", invoices: true })
        expect(on.writes.filter((w) => String(w.body?.webhook_doctype) === "Sales Invoice").map((w) => w.body.webhook_docevent)).toEqual([
            "on_submit",
            "on_cancel",
        ])
    })
})

describe("Set up ERPNext for gateway settlements", () => {
    const masters = {
        company: "Splendx Generators Pvt Ltd",
        gateways: [{ supplier: "Cashfree Payments India Private Limited", item: "Payment Gateway Charges", gst_hsn_code: "997158" }],
        bankAccount: { name: "IDFC Current - SGPL", create: true },
    }
    const ok = (data: any): FrappeResult => ({ ok: true, status: 200, data })

    /** Answers a GET by path, and a list GET by path plus the first filter's field and value. */
    function fakeSite(existing: { accounts?: Record<string, any>; supplier?: any; item?: any } = {}) {
        const writes: Array<{ method: string; path: string; body: any }> = []
        const accounts = existing.accounts ?? {}
        const client: FrappeClient = {
            async get(path, query) {
                if (path === "/api/resource/Company/Splendx%20Generators%20Pvt%20Ltd") return ok({ name: masters.company, abbr: "SGPL" })
                if (path === "/api/method/frappe.client.get_single_value") {
                    return query?.field === "supplier_group" ? ok("Services") : ok(null)
                }
                if (path === "/api/resource/Item%20Group/Services") return ok({ name: "Services" })
                if (path === "/api/resource/Account" && query?.filters) {
                    const filters: any[] = JSON.parse(query.filters)
                    const [field, , value] = filters[0]
                    const isGroup = filters.some(([f, , v]: any[]) => f === "is_group" && v === 1)
                    if (isGroup && field === "account_name" && value === "Indirect Expenses") return ok([{ name: "Indirect Expenses - SGPL" }])
                    if (isGroup && field === "account_name" && value === "Bank Accounts") return ok([{ name: "Bank Accounts - SGPL" }])
                    const hit = Object.values(accounts).find((a: any) => a[field] === value)
                    return ok(hit && !isGroup ? [{ name: hit.name }] : [])
                }
                if (path.startsWith("/api/resource/Account/")) {
                    const name = decodeURIComponent(path.slice("/api/resource/Account/".length))
                    return accounts[name] ? ok(accounts[name]) : { ok: false, status: 404, error: "HTTP 404" }
                }
                if (path === "/api/resource/Supplier/Cashfree%20Payments%20India%20Private%20Limited" && existing.supplier) return ok(existing.supplier)
                if (path === "/api/resource/Supplier") return ok([])
                if (path === "/api/resource/Item/Payment%20Gateway%20Charges" && existing.item) return ok(existing.item)
                return { ok: false, status: 404, error: "HTTP 404: not found" }
            },
            async post(path, body) {
                writes.push({ method: "POST", path, body })
                const name = path === "/api/resource/Account" ? `${body.account_name} - SGPL` : (body.item_code ?? body.supplier_name)
                return ok({ ...body, name })
            },
            async put(path, body) {
                writes.push({ method: "PUT", path, body })
                return ok(body)
            },
            async delete(path) {
                writes.push({ method: "DELETE", path, body: null })
                return ok(null)
            },
        }
        return { client, writes }
    }

    it("creates the expense account, the bank ledger, the supplier and the service item when missing", async () => {
        const site = fakeSite()
        const items = await ensureSettlementMasters(site.client, masters)
        expect(items.map((i) => [i.kind, i.name, i.action])).toEqual([
            ["account", "Payment Gateway Charges - SGPL", "created"],
            ["account", "IDFC Current - SGPL", "created"],
            ["supplier", "Cashfree Payments India Private Limited", "created"],
            ["item", "Payment Gateway Charges", "created"],
        ])
        const [expense, bank, supplier, item] = site.writes.map((w) => w.body)
        expect(expense).toEqual({
            doctype: "Account",
            account_name: "Payment Gateway Charges",
            parent_account: "Indirect Expenses - SGPL",
            company: "Splendx Generators Pvt Ltd",
            is_group: 0,
        })
        expect(bank).toMatchObject({ account_name: "IDFC Current", parent_account: "Bank Accounts - SGPL", account_type: "Bank", is_group: 0 })
        expect(supplier).toEqual({
            doctype: "Supplier",
            supplier_name: "Cashfree Payments India Private Limited",
            supplier_group: "Services",
            supplier_type: "Company",
            country: "India",
        })
        expect(supplier.gstin).toBeUndefined()
        expect(item).toMatchObject({
            item_code: "Payment Gateway Charges",
            item_group: "Services",
            is_stock_item: 0,
            is_purchase_item: 1,
            is_sales_item: 0,
            gst_hsn_code: "997158",
            item_defaults: [{ company: "Splendx Generators Pvt Ltd", expense_account: "Payment Gateway Charges - SGPL" }],
        })
        expect(items[2].detail).toContain("GSTIN and billing address")
        expect(items[2].detail).toContain("input tax credit")
        expect(items[3].detail).toContain("confirm the code")
    })

    it("changes nothing that exists, and still says what the supplier lacks", async () => {
        const site = fakeSite({
            accounts: {
                "Payment Gateway Charges - SGPL": { name: "Payment Gateway Charges - SGPL", account_name: "Payment Gateway Charges" },
                "IDFC Current - SGPL": { name: "IDFC Current - SGPL", account_name: "IDFC Current", account_type: "Bank" },
            },
            supplier: { name: "Cashfree Payments India Private Limited", gstin: "" },
            item: { name: "Payment Gateway Charges", gst_hsn_code: "998599" },
        })
        const items = await ensureSettlementMasters(site.client, masters)
        expect(site.writes).toEqual([])
        expect(items.map((i) => i.action)).toEqual(["unchanged", "unchanged", "unchanged", "unchanged"])
        expect(items[2].detail).toContain("no GSTIN yet")
        expect(items[3].detail).toBe("its HSN/SAC is 998599; left as it is")
    })

    it("does not create the bank account unless asked", async () => {
        const site = fakeSite()
        const items = await ensureSettlementMasters(site.client, { ...masters, bankAccount: { name: "IDFC Current - SGPL", create: false } })
        expect(items[1]).toMatchObject({ name: "IDFC Current - SGPL", action: "error" })
        expect(site.writes.map((w) => w.body.account_name ?? w.body.supplier_name ?? w.body.item_code)).toEqual([
            "Payment Gateway Charges",
            "Cashfree Payments India Private Limited",
            "Payment Gateway Charges",
        ])
    })

    it("runs only when settlements are booked", async () => {
        const off = fakeSite()
        const without = await runErpnextSetup({ client: off.client, doctypes: [], publicUrl: "http://x", secret: "s" })
        expect(without.items).toEqual([])
        expect(off.writes).toEqual([])
        const on = fakeSite()
        const withMasters = await runErpnextSetup({ client: on.client, doctypes: [], publicUrl: "http://x", secret: "s", settlements: masters })
        expect(withMasters.items.map((i) => i.kind)).toEqual(["account", "account", "supplier", "item"])
        expect(withMasters.ok).toBe(true)
    })
})
