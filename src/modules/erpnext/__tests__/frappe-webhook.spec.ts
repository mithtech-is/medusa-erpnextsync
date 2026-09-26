import crypto from "crypto"
import { describe, expect, it } from "vitest"
import {
    frappeEventId,
    frappeSignature,
    parseFrappeWebhookBody,
    planFrappeEvent,
    safeEq,
    verifyFrappeSignature,
} from "../frappe-webhook"

/**
 * Frappe signs `frappe.as_json(data)` — pretty-printed, sorted keys — and
 * sends exactly that string, so the bytes below are shaped the way they
 * arrive: indent 1, `": "` separators, newline between members.
 */
const SECRET = "0123456789abcdef0123456789abcdef"
const BODY = Buffer.from(
    '{\n "doc": {\n  "item_code": "SKU-1",\n  "medusa_sync": 1,\n  "modified": "2026-09-26 10:00:00.000000"\n },\n "doctype": "Item",\n "event": "on_update",\n "name": "SKU-1"\n}',
    "utf8",
)

function sign(body: Buffer, secret: string): string {
    return crypto.createHmac("sha256", secret).update(body).digest("base64")
}

describe("the Frappe webhook signature", () => {
    it("accepts base64 HMAC-SHA256 over the raw body", () => {
        expect(verifyFrappeSignature({ rawBody: BODY, header: sign(BODY, SECRET), secret: SECRET })).toBe(true)
        expect(frappeSignature(BODY, SECRET)).toBe(sign(BODY, SECRET))
    })

    it("accepts the hex spelling a hand-made curl produces", () => {
        const hex = crypto.createHmac("sha256", SECRET).update(BODY).digest("hex")
        expect(verifyFrappeSignature({ rawBody: BODY, header: hex, secret: SECRET })).toBe(true)
    })

    it("refuses a body that changed after signing", () => {
        const tampered = Buffer.from(BODY.toString("utf8").replace('"medusa_sync": 1', '"medusa_sync": 0'), "utf8")
        expect(verifyFrappeSignature({ rawBody: tampered, header: sign(BODY, SECRET), secret: SECRET })).toBe(false)
    })

    it("refuses the wrong secret", () => {
        expect(verifyFrappeSignature({ rawBody: BODY, header: sign(BODY, "other"), secret: SECRET })).toBe(false)
    })

    it("refuses a missing header, a missing secret and a missing body", () => {
        expect(verifyFrappeSignature({ rawBody: BODY, header: undefined, secret: SECRET })).toBe(false)
        expect(verifyFrappeSignature({ rawBody: BODY, header: "", secret: SECRET })).toBe(false)
        expect(verifyFrappeSignature({ rawBody: BODY, header: sign(BODY, SECRET), secret: null })).toBe(false)
        expect(verifyFrappeSignature({ rawBody: null, header: sign(BODY, SECRET), secret: SECRET })).toBe(false)
    })

    it("takes the first value when the header arrived twice", () => {
        expect(
            verifyFrappeSignature({ rawBody: BODY, header: [sign(BODY, SECRET), "junk"], secret: SECRET }),
        ).toBe(true)
    })

    it("compares in constant time and never throws on unequal lengths", () => {
        expect(safeEq("abc", "abc")).toBe(true)
        expect(safeEq("abc", "abcd")).toBe(false)
        expect(safeEq("", "")).toBe(true)
    })
})

describe("the webhook body", () => {
    it("is {event, doctype, name, doc}", () => {
        const res = parseFrappeWebhookBody(BODY)
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.body.event).toBe("on_update")
        expect(res.body.doctype).toBe("Item")
        expect(res.body.name).toBe("SKU-1")
        expect(res.body.doc.item_code).toBe("SKU-1")
    })

    it("accepts a numeric name, as an autoincrement DocType sends it", () => {
        const res = parseFrappeWebhookBody(JSON.stringify({ event: "on_trash", doctype: "Thing", name: 42, doc: {} }))
        expect(res.ok).toBe(true)
        if (res.ok) expect(res.body.name).toBe("42")
    })

    it("refuses anything else, naming the field", () => {
        expect(parseFrappeWebhookBody("not json")).toEqual({ ok: false, message: "body is not JSON" })
        const noDoc = parseFrappeWebhookBody(JSON.stringify({ event: "on_update", doctype: "Item", name: "x" }))
        expect(noDoc.ok).toBe(false)
        if (!noDoc.ok) expect(noDoc.message).toMatch(/^doc:/)
        const badEvent = parseFrappeWebhookBody(JSON.stringify({ event: "after_insert", doctype: "Item", name: "x", doc: {} }))
        expect(badEvent.ok).toBe(false)
        if (!badEvent.ok) expect(badEvent.message).toMatch(/^event:/)
    })

    it("gets one event id per document version, so Frappe's retries share a row", () => {
        const res = parseFrappeWebhookBody(BODY)
        if (!res.ok) throw new Error(res.message)
        expect(frappeEventId(res.body)).toBe("frappe:on_update:Item:SKU-1:2026-09-26 10:00:00.000000")
    })
})

describe("what one webhook means for one mapping", () => {
    const mapping = { medusa_entity: "product", key_erpnext_field: "item_code" }

    it("a ticked document is upserted by the raw key", () => {
        const plan = planFrappeEvent({
            event: "on_update",
            doc: { item_code: "ABC 1", medusa_sync: 1 },
            mapping,
            link: null,
        })
        expect(plan).toMatchObject({ action: "upsert", key: "ABC 1", republish: false })
    })

    it("a ticked document we drafted earlier is republished", () => {
        const plan = planFrappeEvent({
            event: "on_update",
            doc: { item_code: "ABC", medusa_sync: 1 },
            mapping,
            link: { medusa_id: "prod_1", state: "drafted" },
        })
        expect(plan).toMatchObject({ action: "upsert", republish: true })
    })

    it("republishing is a product thing", () => {
        const plan = planFrappeEvent({
            event: "on_update",
            doc: { name: "C-1", medusa_sync: "1" },
            mapping: { medusa_entity: "customer", key_erpnext_field: "name" },
            link: { medusa_id: "cus_1", state: "drafted" },
        })
        expect(plan).toMatchObject({ action: "upsert", republish: false })
    })

    it("an unticked document is drafted through its link", () => {
        const plan = planFrappeEvent({
            event: "on_update",
            doc: { item_code: "ABC", medusa_sync: 0 },
            mapping,
            link: { medusa_id: "prod_1", state: "active" },
        })
        expect(plan).toMatchObject({ action: "draft", by: "link", medusa_id: "prod_1" })
    })

    it("an unticked document with no link is drafted by key, and skipped without one", () => {
        expect(
            planFrappeEvent({ event: "on_update", doc: { item_code: "ABC", medusa_sync: 0 }, mapping, link: null }),
        ).toMatchObject({ action: "draft", by: "key", key: "ABC" })
        expect(
            planFrappeEvent({ event: "on_update", doc: { medusa_sync: 0 }, mapping, link: null }),
        ).toMatchObject({ action: "skip" })
    })

    it("a trashed document is drafted whatever the tick says", () => {
        expect(
            planFrappeEvent({
                event: "on_trash",
                doc: { item_code: "ABC", medusa_sync: 1 },
                mapping,
                link: { medusa_id: "prod_1", state: "active" },
            }),
        ).toMatchObject({ action: "draft", by: "link", medusa_id: "prod_1" })
        expect(
            planFrappeEvent({ event: "on_trash", doc: { item_code: "ABC" }, mapping, link: null }),
        ).toMatchObject({ action: "draft", by: "key", key: "ABC" })
    })

    it("a document without the field is not ours to touch", () => {
        const plan = planFrappeEvent({ event: "on_update", doc: { item_code: "ABC" }, mapping, link: null })
        expect(plan.action).toBe("skip")
        if (plan.action === "skip") expect(plan.reason).toMatch(/Set up ERPNext/)
    })

    it("a ticked document without a key value cannot be placed", () => {
        expect(planFrappeEvent({ event: "on_update", doc: { medusa_sync: 1 }, mapping, link: null })).toMatchObject({
            action: "skip",
        })
    })
})
