import { describe, expect, it } from "vitest"
import { applyMapping, constantHasValue, unmetRequired } from "../mapping-engine"

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
 * A row switched to "fixed value" in the admin and never filled in. It
 * has no source and nothing to send, and writing the blank would put an
 * empty string over whatever ERPNext already holds.
 */
describe("a fixed value nobody filled in", () => {
    const blanks = [undefined, "", "   ", "\t\n"]

    it("is not a value", () => {
        for (const c of blanks) expect(constantHasValue(c)).toBe(false)
    })

    it("counts anything else, including null and falsy scalars", () => {
        for (const c of [null, 0, false, "x", " x "]) {
            expect(constantHasValue(c)).toBe(true)
        }
    })

    it("is left out of the payload rather than written as a blank", () => {
        const res = applyMapping({
            direction: "push",
            fields: [
                { medusa_path: "handle", erpnext_field: "item_code" },
                { medusa_path: "", erpnext_field: "item_group", constant: "" },
                { medusa_path: "", erpnext_field: "stock_uom", constant: "  " },
            ],
            mappingDirection: "push",
            source: { handle: "t-shirt" },
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({ item_code: "t-shirt" })
    })

    it("is reported as skipped, unlike a constant that fires", () => {
        // The one case where a constant belongs in `skippedFields`: it
        // moved nothing, and that is a surprise worth surfacing.
        const res = applyMapping({
            direction: "push",
            fields: [
                { medusa_path: "", erpnext_field: "item_group", constant: "" },
                { medusa_path: "", erpnext_field: "stock_uom", constant: "Nos" },
            ],
            mappingDirection: "push",
            source: {},
        })
        expect(res.ok && res.skippedFields).toContain("item_group")
        expect(res.ok && res.skippedFields).not.toContain("stock_uom")
    })

    it("still writes a constant that is null, which clears the field", () => {
        const res = applyMapping({
            direction: "push",
            fields: [{ medusa_path: "", erpnext_field: "item_group", constant: null }],
            mappingDirection: "push",
            source: {},
        })
        expect(res.ok && res.payload).toEqual({ item_group: null })
    })

    it("does not cover the mandatory field it names", () => {
        // The bug this guards: a blank fixed value on `item_group` made
        // the rehearsal report full coverage, so the mapping could be
        // switched on and then failed on the first real record.
        const unmet = unmetRequired({
            direction: "push",
            mappingDirection: "push",
            required: [{ name: "item_group", label: "Item Group" }],
            fields: [{ medusa_path: "", erpnext_field: "item_group", constant: "" }],
        })
        expect(unmet.map((f) => f.name)).toEqual(["item_group"])
    })

    it("covers it once somebody says what to send", () => {
        const unmet = unmetRequired({
            direction: "push",
            mappingDirection: "push",
            required: [{ name: "item_group", label: "Item Group" }],
            fields: [
                { medusa_path: "", erpnext_field: "item_group", constant: "Products" },
            ],
        })
        expect(unmet).toEqual([])
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

// ── Types and conversion ────────────────────────────────────────────

import { coerce, parseDateValue, transformFor } from "../mapping-engine"

describe("a transform that cannot coerce", () => {
    const fields = [
        { medusa_path: "weight", erpnext_field: "weight_per_unit", direction: "both" as const, transform: "number" },
        { medusa_path: "title", erpnext_field: "item_name", direction: "both" as const },
    ]

    it("skips the field and never writes null over the target", () => {
        const res = applyMapping({
            direction: "push",
            fields,
            mappingDirection: "both",
            source: { weight: "heavy", title: "Bolt" },
        })
        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(res.payload).toEqual({ item_name: "Bolt" })
        expect(res.payload).not.toHaveProperty("weight_per_unit")
        expect(res.skippedFields).toEqual(["weight_per_unit"])
        expect(res.failures).toEqual([
            { field: "weight_per_unit", transform: "number", reason: '"heavy" is not a number' },
        ])
    })

    it("converts what it can", () => {
        const res = applyMapping({ direction: "push", fields, mappingDirection: "both", source: { weight: "12.5", title: "Bolt" } })
        expect(res.ok && res.payload).toEqual({ weight_per_unit: 12.5, item_name: "Bolt" })
    })

    it("boolean and check refuse a value that is not yes/no", () => {
        expect(coerce("maybe", "boolean")).toEqual({ ok: false, reason: '"maybe" is not a yes/no value' })
        expect(coerce("yes", "boolean")).toEqual({ ok: true, value: true })
        expect(coerce(true, "check")).toEqual({ ok: true, value: 1 })
        expect(coerce("0", "check")).toEqual({ ok: true, value: 0 })
        expect(coerce("x", "check").ok).toBe(false)
    })

    it("decimal rounds to the places asked; text refuses a list", () => {
        expect(coerce("12.3456", "decimal:2")).toEqual({ ok: true, value: 12.35 })
        expect(coerce(7, "decimal:0")).toEqual({ ok: true, value: 7 })
        expect(coerce("abc", "decimal:2").ok).toBe(false)
        expect(coerce(42, "text")).toEqual({ ok: true, value: "42" })
        expect(coerce([1, 2], "text").ok).toBe(false)
    })
})

describe("per-direction transforms", () => {
    it("uses transform_push on push and transform_pull on pull, with transform as the fallback", () => {
        const pair = { medusa_path: "x", erpnext_field: "y", transform: "trim", transform_pull: "uppercase" }
        expect(transformFor(pair, "push")).toEqual({ code: "trim", inherited: true })
        expect(transformFor(pair, "pull")).toEqual({ code: "uppercase", inherited: false })
        expect(transformFor({ medusa_path: "x", erpnext_field: "y" }, "pull")).toEqual({ code: null, inherited: false })
    })

    it("a shared map: runs forward on push and in reverse on pull", () => {
        const fields = [
            { medusa_path: "status", erpnext_field: "custom_status", direction: "both" as const, transform: "map:published=Active,draft=Inactive" },
        ]
        const out = applyMapping({ direction: "push", fields, mappingDirection: "both", source: { status: "published" } })
        expect(out.ok && out.payload).toEqual({ custom_status: "Active" })
        const back = applyMapping({ direction: "pull", fields, mappingDirection: "both", source: { custom_status: "Inactive" } })
        expect(back.ok && back.payload).toEqual({ status: "draft" })
    })

    it("an explicit transform_pull map: is applied as written", () => {
        const fields = [
            { medusa_path: "status", erpnext_field: "custom_status", direction: "both" as const, transform_pull: "map:Active=published" },
        ]
        const back = applyMapping({ direction: "pull", fields, mappingDirection: "both", source: { custom_status: "Active" } })
        expect(back.ok && back.payload).toEqual({ status: "published" })
    })

    it("a value the map does not know is skipped, not written", () => {
        const fields = [{ medusa_path: "status", erpnext_field: "s", direction: "both" as const, transform: "map:a=b" }]
        const out = applyMapping({ direction: "push", fields, mappingDirection: "both", source: { status: "z" } })
        expect(out.ok && out.payload).toEqual({})
        expect(out.ok && out.skippedFields).toEqual(["s"])
    })
})

describe("phones and dates", () => {
    it("normalises a phone to E.164 using the default region, and skips an invalid one", () => {
        expect(coerce("98450 12345", "phone", { phoneRegion: "IN" })).toEqual({ ok: true, value: "+919845012345" })
        expect(coerce("+1 415 555 2671", "phone", { phoneRegion: "IN" })).toEqual({ ok: true, value: "+14155552671" })
        expect(coerce("98450 12345", "phone:IN")).toEqual({ ok: true, value: "+919845012345" })
        expect(coerce("12", "phone", { phoneRegion: "IN" }).ok).toBe(false)
        expect(coerce("98450 12345", "phone").ok).toBe(false)
    })

    it("reads a naive Frappe datetime in the site's timezone", () => {
        const d = parseDateValue("2026-09-26 10:00:00.000000", "Asia/Kolkata")
        expect(d?.toISOString()).toBe("2026-09-26T04:30:00.000Z")
        expect(parseDateValue("2026-09-26", "Asia/Kolkata")?.toISOString()).toBe("2026-09-25T18:30:00.000Z")
        expect(parseDateValue("2026-09-26T04:30:00.000Z", "Asia/Kolkata")?.toISOString()).toBe("2026-09-26T04:30:00.000Z")
        expect(parseDateValue("not a date", "Asia/Kolkata")).toBeNull()
    })

    it("writes a Frappe datetime in the site's timezone and an ISO one back", () => {
        expect(coerce("2026-09-26T04:30:00.000Z", "datetime_frappe", { timezone: "Asia/Kolkata" })).toEqual({
            ok: true,
            value: "2026-09-26 10:00:00",
        })
        expect(coerce("2026-09-26T20:30:00.000Z", "date_yyyy_mm_dd", { timezone: "Asia/Kolkata" })).toEqual({ ok: true, value: "2026-09-27" })
        expect(coerce("2026-09-26 10:00:00", "date_iso", { timezone: "Asia/Kolkata" })).toEqual({
            ok: true,
            value: "2026-09-26T04:30:00.000Z",
        })
        expect(coerce("never", "date_iso").ok).toBe(false)
    })
})

describe("fixed and default values, either side", () => {
    it("a pull-side fixed value lands in Medusa", () => {
        const fields = [
            { medusa_path: "status", erpnext_field: "", direction: "pull" as const, constant_pull: "published" },
            { medusa_path: "metadata.source", erpnext_field: "", direction: "pull" as const, constant_pull: "erpnext" },
            { medusa_path: "title", erpnext_field: "item_name", direction: "pull" as const },
        ]
        const res = applyMapping({ direction: "pull", fields, mappingDirection: "pull", source: { item_name: "Bolt", status: "whatever" } })
        expect(res.ok && res.payload).toEqual({ status: "published", metadata: { source: "erpnext" }, title: "Bolt" })
        expect(res.ok && res.skippedFields).toEqual([])
    })

    it("a push-side fixed value is still push-only, and a pull-side one never pushes", () => {
        const fields = [
            { medusa_path: "", erpnext_field: "item_group", direction: "both" as const, constant: "Products" },
            { medusa_path: "status", erpnext_field: "", direction: "both" as const, constant_pull: "published" },
        ]
        const push = applyMapping({ direction: "push", fields, mappingDirection: "both", source: { status: "draft" } })
        expect(push.ok && push.payload).toEqual({ item_group: "Products" })
        const pull = applyMapping({ direction: "pull", fields, mappingDirection: "both", source: { item_group: "Raw" } })
        expect(pull.ok && pull.payload).toEqual({ status: "published" })
    })

    it("a blank pull-side fixed value is not a source", () => {
        const fields = [{ medusa_path: "status", erpnext_field: "", direction: "pull" as const, constant_pull: "  " }]
        const res = applyMapping({ direction: "pull", fields, mappingDirection: "pull", source: {} })
        expect(res.ok && res.payload).toEqual({})
        expect(res.ok && res.skippedFields).toEqual(["status"])
        expect(unmetRequired({ direction: "pull", fields, mappingDirection: "pull", required: [{ name: "status" }] })).toEqual([{ name: "status" }])
        expect(
            unmetRequired({
                direction: "pull",
                fields: [{ ...fields[0], constant_pull: "published" }],
                mappingDirection: "pull",
                required: [{ name: "status" }],
            }),
        ).toEqual([])
    })

    it("a default applies only when the source is empty, per direction", () => {
        const fields = [
            { medusa_path: "description", erpnext_field: "description", direction: "both" as const, default_push: "No description", default_pull: "(from ERPNext)" },
        ]
        const filled = applyMapping({ direction: "push", fields, mappingDirection: "both", source: { description: "Real" } })
        expect(filled.ok && filled.payload).toEqual({ description: "Real" })
        const empty = applyMapping({ direction: "push", fields, mappingDirection: "both", source: { description: "" } })
        expect(empty.ok && empty.payload).toEqual({ description: "No description" })
        const pulled = applyMapping({ direction: "pull", fields, mappingDirection: "both", source: { description: null } })
        expect(pulled.ok && pulled.payload).toEqual({ description: "(from ERPNext)" })
    })

    it("the shared default serves both directions unless a direction has its own", () => {
        const fields = [{ medusa_path: "a", erpnext_field: "b", direction: "both" as const, default: "shared", default_pull: "pulled" }]
        expect(applyMapping({ direction: "push", fields, mappingDirection: "both", source: {} }).ok).toBe(true)
        const push = applyMapping({ direction: "push", fields, mappingDirection: "both", source: {} })
        expect(push.ok && push.payload).toEqual({ b: "shared" })
        const pull = applyMapping({ direction: "pull", fields, mappingDirection: "both", source: {} })
        expect(pull.ok && pull.payload).toEqual({ a: "pulled" })
    })

    it("a per-direction default counts toward required coverage in that direction only", () => {
        const fields = [{ medusa_path: "", erpnext_field: "item_group", direction: "both" as const, default_push: "Products" }]
        expect(unmetRequired({ direction: "push", fields, mappingDirection: "both", required: [{ name: "item_group" }] })).toEqual([])
        expect(unmetRequired({ direction: "pull", fields, mappingDirection: "both", required: [{ name: "" }] })).toEqual([{ name: "" }])
    })
})
