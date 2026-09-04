import { describe, expect, it } from "vitest"

import {
    DEFAULT_TRIP_AFTER,
    afterFailure,
    afterSuccess,
    allows,
    isTripped,
    stateOf,
    threshold,
} from "../breaker"

const open = (over: Record<string, any> = {}) => ({
    consecutive_failures: 0,
    tripped_at: null,
    trip_after: null,
    ...over,
})

describe("the threshold", () => {
    it("is ten unless the connection says otherwise", () => {
        expect(DEFAULT_TRIP_AFTER).toBe(10)
        expect(threshold(open())).toBe(10)
        expect(threshold(open({ trip_after: 3 }))).toBe(3)
    })

    it("ignores a nonsense value rather than tripping on the first failure", () => {
        expect(threshold(open({ trip_after: 0 }))).toBe(10)
        expect(threshold(open({ trip_after: -5 }))).toBe(10)
        expect(threshold(null)).toBe(10)
    })
})

describe("counting", () => {
    it("one failure is not a pattern", () => {
        const patch = afterFailure(open())
        expect(patch?.consecutive_failures).toBe(1)
        expect(patch?.tripped_at).toBeUndefined()
    })

    it("enough of them is", () => {
        const patch = afterFailure(open({ consecutive_failures: 9 }))
        expect(patch?.consecutive_failures).toBe(10)
        expect(patch?.tripped_at).toBeInstanceOf(Date)
    })

    it("does not re-stamp a connection that is already tripped", () => {
        // Otherwise "stopped trying at" creeps forward with every skipped
        // attempt and stops telling you when it actually happened.
        const already = open({ consecutive_failures: 20, tripped_at: new Date("2026-09-01") })
        expect(afterFailure(already)?.tripped_at).toBeUndefined()
    })

    it("one success closes it", () => {
        const patch = afterSuccess(open({ consecutive_failures: 12, tripped_at: new Date() }))
        expect(patch).toEqual({ consecutive_failures: 0, tripped_at: null })
    })

    it("a success on an already-open connection writes nothing", () => {
        // Every successful push would otherwise be a needless update.
        expect(afterSuccess(open())).toBeNull()
    })

    it("a success partway starts the count again", () => {
        const patch = afterSuccess(open({ consecutive_failures: 4 }))
        expect(patch?.consecutive_failures).toBe(0)
    })
})

describe("rehearsals never touch it", () => {
    it("cannot trip it", () => {
        // Testing a mapping against a site that is down would otherwise
        // take real traffic down with it.
        expect(afterFailure(open({ consecutive_failures: 9 }), { isTest: true })).toBeNull()
    })

    it("cannot close it either", () => {
        const tripped = open({ consecutive_failures: 12, tripped_at: new Date() })
        expect(afterSuccess(tripped, { isTest: true })).toBeNull()
    })
})

describe("what it stops", () => {
    it("nothing, while it is open", () => {
        expect(allows(open())).toBe(true)
        expect(isTripped(open())).toBe(false)
    })

    it("ordinary deliveries, once it is tripped", () => {
        const tripped = open({ tripped_at: new Date() })
        expect(allows(tripped)).toBe(false)
        expect(isTripped(tripped)).toBe(true)
    })

    it("but never the probe", () => {
        // Somebody has to knock, or it never learns the site came back.
        expect(allows(open({ tripped_at: new Date() }), { probe: true })).toBe(true)
    })

    it("and never a rehearsal", () => {
        expect(allows(open({ tripped_at: new Date() }), { isTest: true })).toBe(true)
    })

    it("nothing at all when there is no connection row to read", () => {
        expect(allows(null)).toBe(true)
        expect(allows(undefined)).toBe(true)
    })
})

describe("reading the state", () => {
    it("survives the columns being empty", () => {
        expect(stateOf(null)).toEqual({
            consecutive_failures: 0,
            tripped: false,
            tripped_at: null,
            trip_after: 10,
        })
    })

    it("never reports a negative count", () => {
        expect(stateOf(open({ consecutive_failures: -3 })).consecutive_failures).toBe(0)
    })
})
