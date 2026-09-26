import { describe, expect, it } from "vitest"
import {
    isSyncDoctype,
    normalizeSyncDoctypes,
    resolveProductsDoctype,
    selectionOf,
    withSelectionFilter,
} from "../selection"

const LIST = [{ doctype: "Item", mode: "allow" as const }]

describe("the pull filter on a selection DocType", () => {
    it("always carries medusa_sync = 1", () => {
        expect(withSelectionFilter([["disabled", "=", 0]], "Item", LIST)).toEqual([
            ["disabled", "=", 0],
            ["medusa_sync", "=", 1],
        ])
        expect(withSelectionFilter(null, "Item", LIST)).toEqual([["medusa_sync", "=", 1]])
    })

    it("does not repeat a clause the operator already wrote", () => {
        expect(withSelectionFilter([["medusa_sync", "=", 1]], "Item", LIST)).toEqual([["medusa_sync", "=", 1]])
    })

    it("leaves a DocType that is not under selection alone", () => {
        expect(withSelectionFilter([["disabled", "=", 0]], "Customer", LIST)).toEqual([["disabled", "=", 0]])
        expect(withSelectionFilter([], "Item", [])).toEqual([])
    })

    it("returns a new array", () => {
        const input = [["a", "=", 1]]
        const out = withSelectionFilter(input, "Item", LIST)
        expect(out).not.toBe(input)
        expect(input).toHaveLength(1)
    })
})

describe("the list of selection DocTypes", () => {
    it("is trimmed, deduplicated and defaults to allow", () => {
        expect(
            normalizeSyncDoctypes([
                { doctype: " Item ", mode: "DENY" },
                "Item",
                { doctype: "Website Item" },
                { doctype: "" },
                null,
            ]),
        ).toEqual([
            { doctype: "Item", mode: "deny" },
            { doctype: "Website Item", mode: "allow" },
        ])
        expect(normalizeSyncDoctypes(undefined)).toEqual([])
        expect(isSyncDoctype("Website Item", normalizeSyncDoctypes(["Website Item"]))).toBe(true)
        expect(isSyncDoctype("item", LIST)).toBe(false)
    })
})

describe("reading the tick off a document", () => {
    it("is on for 1, true and '1'; off otherwise; absent when the field is missing", () => {
        expect(selectionOf({ medusa_sync: 1 })).toBe("on")
        expect(selectionOf({ medusa_sync: true })).toBe("on")
        expect(selectionOf({ medusa_sync: "1" })).toBe("on")
        expect(selectionOf({ medusa_sync: 0 })).toBe("off")
        expect(selectionOf({ medusa_sync: null })).toBe("off")
        expect(selectionOf({})).toBe("absent")
        expect(selectionOf(null)).toBe("absent")
    })
})

describe("which DocType holds the catalogue", () => {
    it("is what the enabled product mapping says, else the first selection DocType, else Item", () => {
        expect(
            resolveProductsDoctype(LIST, [{ medusa_entity: "product", doctype: "Website Item", enabled: true }]),
        ).toBe("Website Item")
        expect(
            resolveProductsDoctype([{ doctype: "Thing", mode: "allow" }], [
                { medusa_entity: "product", doctype: "Website Item", enabled: false },
            ]),
        ).toBe("Thing")
        expect(resolveProductsDoctype([], [])).toBe("Item")
    })
})
