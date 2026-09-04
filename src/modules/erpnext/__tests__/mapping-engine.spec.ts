import { describe, expect, it } from "vitest"
import { applyMapping } from "../mapping-engine"

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
