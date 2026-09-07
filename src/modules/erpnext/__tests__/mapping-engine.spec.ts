import { describe, expect, it } from "vitest"
import { applyMapping, unmetRequired } from "../mapping-engine"

/**
 * The engine that turns a record on one side into a payload for the
 * other. These cover the direction rules, since "product images flow
 * ERPNext to Medusa but never back" is expressed entirely through them.
 */
describe("per-field direction", () => {
    const source = {
        email: "a@b.c",
        first_name: "Ada",
        thumbnail: "/files/from-medusa.png",
        internal_cost: 42,
    }

    const fields = [
        { medusa_path: "email", erpnext_field: "email_id", direction: "both" as const },
        { medusa_path: "first_name", erpnext_field: "customer_name", direction: "push" as const },
        { medusa_path: "thumbnail", erpnext_field: "image", direction: "pull" as const },
        { medusa_path: "internal_cost", erpnext_field: "cost", direction: "none" as const },
    ]

    it("pushes both-way and push-only fields", () => {
        const res = applyMapping({ direction: "push", fields, mappingDirection: "both", source })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({ email_id: "a@b.c", customer_name: "Ada" })
    })

    it("never moves a Don't Sync field in either direction", () => {
        const push = applyMapping({ direction: "push", fields, mappingDirection: "both", source })
        const pull = applyMapping({
            direction: "pull",
            fields,
            mappingDirection: "both",
            source: { email_id: "a@b.c", image: "/files/erp.png", cost: 42 },
        })
        expect(push.ok && push.payload).not.toHaveProperty("cost")
        expect(pull.ok && pull.payload).not.toHaveProperty("internal_cost")
    })

    it("pulls both-way and pull-only fields", () => {
        const res = applyMapping({
            direction: "pull",
            fields,
            mappingDirection: "both",
            source: { email_id: "a@b.c", customer_name: "Ada", image: "/files/erp.png" },
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({ email: "a@b.c", thumbnail: "/files/erp.png" })
    })

    it("falls back to the mapping's own direction when a pair has none", () => {
        const res = applyMapping({
            direction: "push",
            fields: [{ medusa_path: "email", erpnext_field: "email_id" }],
            mappingDirection: "pull",
            source,
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({})
    })

    it("a mapping set to Don't Sync moves nothing at all", () => {
        const res = applyMapping({
            direction: "push",
            fields: [{ medusa_path: "email", erpnext_field: "email_id" }],
            mappingDirection: "none",
            source,
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({})
    })
})

/**
 * A fixed value written to an ERPNext field that has no Medusa
 * counterpart. `Item.item_group` and `Item.stock_uom` are mandatory Links
 * with no default, and nothing in a Medusa product corresponds to either —
 * without a constant, a product push cannot satisfy the DocType at all.
 *
 * Distinct from `default`, which fills in when a mapped source is empty.
 * A constant has no source to be empty.
 */
describe("fixed-value fields", () => {
    const fields = [
        { medusa_path: "handle", erpnext_field: "item_code", direction: "both" as const },
        { medusa_path: "", erpnext_field: "item_group", constant: "Products" },
        { medusa_path: "", erpnext_field: "stock_uom", constant: "Nos" },
    ]

    it("writes the constant on push whatever the source holds", () => {
        const res = applyMapping({
            direction: "push",
            fields,
            mappingDirection: "both",
            source: { handle: "t-shirt" },
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({
            item_code: "t-shirt",
            item_group: "Products",
            stock_uom: "Nos",
        })
    })

    it("writes the constant even when the record is otherwise empty", () => {
        const res = applyMapping({
            direction: "push",
            fields,
            mappingDirection: "both",
            source: {},
        })
        expect(res.ok && res.payload).toEqual({ item_group: "Products", stock_uom: "Nos" })
    })

    it("never writes a constant back into Medusa on pull", () => {
        // "Products" is our answer to ERPNext's requirement, not a fact
        // about the store. Pulling it back would invent a field on the
        // Medusa record that nobody asked for.
        const res = applyMapping({
            direction: "pull",
            fields,
            mappingDirection: "both",
            source: { item_code: "t-shirt", item_group: "Products", stock_uom: "Nos" },
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({ handle: "t-shirt" })
    })

    it("does not report a constant as a skipped field", () => {
        // `skippedFields` is what the operator reads to find mappings that
        // did nothing. A constant always fires, so listing it is noise.
        const res = applyMapping({
            direction: "pull",
            fields,
            mappingDirection: "both",
            source: { item_code: "t-shirt" },
        })
        expect(res.ok && res.skippedFields).not.toContain("item_group")
    })

    it("applies a transform to a constant", () => {
        const res = applyMapping({
            direction: "push",
            fields: [{ medusa_path: "", erpnext_field: "item_group", constant: "Products", transform: "uppercase" }],
            mappingDirection: "push",
            source: {},
        })
        expect(res.ok && res.payload).toEqual({ item_group: "PRODUCTS" })
    })

    it("accepts a non-string constant", () => {
        const res = applyMapping({
            direction: "push",
            fields: [
                { medusa_path: "", erpnext_field: "is_stock_item", constant: 0 },
                { medusa_path: "", erpnext_field: "disabled", constant: false },
            ],
            mappingDirection: "push",
            source: {},
        })
        expect(res.ok && res.payload).toEqual({ is_stock_item: 0, disabled: false })
    })

    it("honours a per-field direction of none on a constant", () => {
        const res = applyMapping({
            direction: "push",
            fields: [{ medusa_path: "", erpnext_field: "item_group", constant: "Products", direction: "none" as const }],
            mappingDirection: "push",
            source: {},
        })
        expect(res.ok && res.payload).toEqual({})
    })
})

/**
 * A mapping that leaves a mandatory field on the receiving side with no
 * source does not fail when it is written — it fails later, on the first
 * real record, with the far side rejecting the document. The rehearsal is
 * the right place to notice, because that is what gates switching it on.
 */
describe("required coverage", () => {
    const required = [
        { name: "item_code", label: "Item Code" },
        { name: "item_group", label: "Item Group" },
        { name: "stock_uom", label: "Stock UOM" },
    ]

    it("reports a required target field nothing writes", () => {
        const unmet = unmetRequired({
            direction: "push",
            mappingDirection: "push",
            required,
            fields: [{ medusa_path: "handle", erpnext_field: "item_code" }],
        })
        expect(unmet.map((f) => f.name)).toEqual(["item_group", "stock_uom"])
    })

    it("counts a fixed value as covering one", () => {
        const unmet = unmetRequired({
            direction: "push",
            mappingDirection: "push",
            required,
            fields: [
                { medusa_path: "handle", erpnext_field: "item_code" },
                { medusa_path: "", erpnext_field: "item_group", constant: "Products" },
                { medusa_path: "", erpnext_field: "stock_uom", constant: "Nos" },
            ],
        })
        expect(unmet).toEqual([])
    })

    it("counts a default as covering one", () => {
        // `default` fires when the mapped source is empty, so the field is
        // never sent blank.
        const unmet = unmetRequired({
            direction: "push",
            mappingDirection: "push",
            required: [{ name: "item_group" }],
            fields: [{ medusa_path: "collection.title", erpnext_field: "item_group", default: "Products" }],
        })
        expect(unmet).toEqual([])
    })

    it("does not count a pair that never flows in this direction", () => {
        // A pull-only pair writes nothing on push, so it cannot satisfy a
        // field the push has to fill.
        const unmet = unmetRequired({
            direction: "push",
            mappingDirection: "both",
            required: [{ name: "item_group" }],
            fields: [{ medusa_path: "x", erpnext_field: "item_group", direction: "pull" }],
        })
        expect(unmet.map((f) => f.name)).toEqual(["item_group"])
    })

    it("does not count a pair with no source at all", () => {
        const unmet = unmetRequired({
            direction: "push",
            mappingDirection: "push",
            required: [{ name: "item_group" }],
            fields: [{ medusa_path: "", erpnext_field: "item_group" }],
        })
        expect(unmet.map((f) => f.name)).toEqual(["item_group"])
    })

    it("checks the Medusa side when pulling", () => {
        const unmet = unmetRequired({
            direction: "pull",
            mappingDirection: "pull",
            required: [{ name: "title" }, { name: "handle" }],
            fields: [{ medusa_path: "handle", erpnext_field: "item_code" }],
        })
        expect(unmet.map((f) => f.name)).toEqual(["title"])
    })

    it("is empty when the receiving side requires nothing", () => {
        expect(
            unmetRequired({
                direction: "push",
                mappingDirection: "push",
                required: [],
                fields: [],
            }),
        ).toEqual([])
    })
})
