import { describe, expect, it } from "vitest"
import type { FrappeClient, FrappeResult } from "../frappe-client"
import {
    ON_TRASH_CONDITION,
    ON_UPDATE_CONDITION,
    buildCustomField,
    buildWebhook,
    customFieldName,
    ensureCustomField,
    ensureWebhook,
    fingerprintOf,
    inboundUrl,
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

    it("a Select field with the three directions, whose default follows the mode", () => {
        const allow = buildCustomField("Item", "allow")
        expect(allow).toMatchObject({
            dt: "Item",
            fieldname: "medusa_sync",
            label: "Sync to Medusa",
            fieldtype: "Select",
            options: "\nERPNext → Medusa\nMedusa → ERPNext\nBoth",
            default: "",
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

    it("conditions that fire for a document that moves, or moved, ERPNext → Medusa", () => {
        const tuple = '("ERPNext → Medusa", "Both")'
        expect(ON_UPDATE_CONDITION).toBe(
            `doc.get("medusa_sync") in ${tuple} or (doc.get_doc_before_save() and doc.get_doc_before_save().get("medusa_sync") in ${tuple})`,
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
        expect(drifted.writes[0]).toMatchObject({ method: "PUT", body: { default: "" } })
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
