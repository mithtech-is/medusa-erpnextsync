import { describe, expect, it } from "vitest"
import { ECHO_WINDOW_MS, entityRefOf, isWithinEchoWindow, pushChangesRemote } from "../echo"

describe("entityRefOf", () => {
    it("names the record a mapping-driven apply wrote", () => {
        const result = {
            via: "mapping",
            results: [{ mapping: "Customer ↔ Customer", entity: "customer", id: "cus_1", ok: true }],
        }
        expect(entityRefOf(result)).toBe("customer:cus_1")
    })

    it("skips a mapping that failed and takes the one that wrote", () => {
        const result = {
            results: [
                { mapping: "a", entity: "product", id: "prod_1", ok: false, error: "boom" },
                { mapping: "b", entity: "product", id: "prod_2", ok: true },
            ],
        }
        expect(entityRefOf(result)).toBe("product:prod_2")
    })

    it("accepts a row that reports no ok flag at all", () => {
        // The upsert branch reports `created`, not `ok`; absence is not failure.
        expect(entityRefOf({ results: [{ entity: "customer", id: "cus_9", created: true }] })).toBe(
            "customer:cus_9",
        )
    })

    it("returns null when nothing was written", () => {
        expect(entityRefOf(null)).toBeNull()
        expect(entityRefOf({})).toBeNull()
        expect(entityRefOf({ results: [] })).toBeNull()
        expect(entityRefOf({ results: [{ mapping: "a", skipped: "no key" }] })).toBeNull()
        expect(entityRefOf({ results: [{ entity: "customer", ok: true }] })).toBeNull()
        expect(entityRefOf({ pong: true })).toBeNull()
    })
})

describe("echo window", () => {
    const now = 1_700_000_000_000

    it("counts a write from a moment ago", () => {
        expect(isWithinEchoWindow(new Date(now - 5_000), now)).toBe(true)
    })

    it("ignores a write from long before", () => {
        expect(isWithinEchoWindow(new Date(now - ECHO_WINDOW_MS - 1_000), now)).toBe(false)
    })

    it("accepts an ISO string as well as a Date", () => {
        expect(isWithinEchoWindow(new Date(now - 1_000).toISOString(), now)).toBe(true)
    })

    it("treats a missing or unreadable timestamp as no cause", () => {
        expect(isWithinEchoWindow(null, now)).toBe(false)
        expect(isWithinEchoWindow(undefined, now)).toBe(false)
        expect(isWithinEchoWindow("not a date", now)).toBe(false)
    })

    it("tolerates a small clock skew forward", () => {
        expect(isWithinEchoWindow(new Date(now + 2_000), now)).toBe(true)
    })
})

describe("pushChangesRemote", () => {
    const remote = { email_id: "zz@example.com", mobile_no: "+919000000001", gstin: "29ZZZPZ0001Z1Z5", disabled: 0, qty: 2 }

    it("is false for an echo: every value is already on the document", () => {
        expect(pushChangesRemote({ email_id: "zz@example.com", mobile_no: "+919000000001", gstin: "29ZZZPZ0001Z1Z5" }, remote)).toBe(false)
    })

    it("is true for an edit made inside the window", () => {
        expect(pushChangesRemote({ email_id: "zz@example.com", mobile_no: "+919000000004" }, remote)).toBe(true)
    })

    it("reads Frappe's 0/1, numbers and blanks as the values they mean", () => {
        expect(pushChangesRemote({ disabled: false, qty: "2", pan: "" }, { ...remote, pan: null })).toBe(false)
        expect(pushChangesRemote({ disabled: true }, remote)).toBe(true)
    })

    it("counts a document it could not read as changed", () => {
        expect(pushChangesRemote({ email_id: "zz@example.com" }, null)).toBe(true)
    })
})
