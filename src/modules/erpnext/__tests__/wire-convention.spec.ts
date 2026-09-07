import { describe, expect, it } from "vitest"
import * as envelope from "../envelope"
import { applyMapping } from "../mapping-engine"

/**
 * One translation per message, and the envelope kind says which side
 * does it. An `event` body carries the sender's own fieldnames and the
 * receiver maps; a `mapped` body carries the receiver's fieldnames and
 * the receiver applies it as it is.
 *
 * `medusync/tests/test_wire_convention.py` is the other half. Every pair
 * here has a different name on each side on purpose: same-named pairs
 * survive either convention, which is how the 2026-09-06 drop stayed
 * invisible.
 */
const fields = [
    { medusa_path: "handle", erpnext_field: "item_code", direction: "both" as const },
    { medusa_path: "title", erpnext_field: "item_name", direction: "both" as const },
    { medusa_path: "description", erpnext_field: "description", direction: "both" as const },
]

describe("an event from ERPNext is keyed by Frappe fieldnames", () => {
    it("lands every mapped field on its Medusa path", () => {
        const res = applyMapping({
            direction: "pull",
            fields,
            mappingDirection: "both",
            source: { item_code: "t-shirt", item_name: "T Shirt", description: "Cotton" },
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({ handle: "t-shirt", title: "T Shirt", description: "Cotton" })
        expect(res.skippedFields).toEqual([])
    })

    it("carries only the same-named fields when the sender translated first", () => {
        // What `build_payload` used to send. Only `description` arrived,
        // and Medusa refused the product for having no title.
        const res = applyMapping({
            direction: "pull",
            fields,
            mappingDirection: "both",
            source: { handle: "t-shirt", title: "T Shirt", description: "Cotton" },
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({ description: "Cotton" })
        expect(res.skippedFields).toEqual(["item_code", "item_name"])
    })

    it("travels as `data`, untouched by the envelope", () => {
        const env = envelope.build({
            event: "item.created",
            event_id: "frappe:Item:t-shirt:1",
            site_id: "erp",
            data: { item_code: "t-shirt", item_name: "T Shirt" },
        })
        expect(env.kind).toBe(envelope.KIND_EVENT)
        expect(env.data).toEqual({ item_code: "t-shirt", item_name: "T Shirt" })
        expect(env).not.toHaveProperty("payload")
    })
})

describe("a mapped push to ERPNext is keyed by Frappe fieldnames", () => {
    it("writes the payload in the receiver's names", () => {
        const res = applyMapping({
            direction: "push",
            fields,
            mappingDirection: "both",
            source: { handle: "t-shirt", title: "T Shirt", description: "Cotton" },
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({ item_code: "t-shirt", item_name: "T Shirt", description: "Cotton" })
    })

    it("travels as `payload` under kind=mapped, untouched by the envelope", () => {
        const env = envelope.build({
            event: "product.created",
            event_id: "medusa:product.created:prod_1",
            site_id: "store",
            kind: envelope.KIND_MAPPED,
            doctype: "Item",
            key_field: "item_code",
            key_value: "t-shirt",
            payload: { item_code: "t-shirt", item_name: "T Shirt" },
        })
        expect(env.kind).toBe(envelope.KIND_MAPPED)
        expect(env.payload).toEqual({ item_code: "t-shirt", item_name: "T Shirt" })
        expect(env).not.toHaveProperty("data")
    })
})
