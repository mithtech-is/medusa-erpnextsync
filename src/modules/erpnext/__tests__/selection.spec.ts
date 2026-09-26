import { describe, expect, it } from "vitest"
import {
    DIRECTION_BOTH,
    DIRECTION_ERPNEXT_TO_MEDUSA,
    DIRECTION_MEDUSA_TO_ERPNEXT,
    allowsPull,
    allowsPush,
    effectiveDirection,
    isSyncDoctype,
    normalizeSyncDoctypes,
    parseRecordDirection,
    pushAllowedByRecord,
    reconcileDecision,
    resolveProductsDoctype,
    selectionDefault,
    selectionOf,
    withSelectionFilter,
} from "../selection"

const LIST = [{ doctype: "Item", mode: "allow" as const }]

describe("the pull filter on a selection DocType", () => {
    it("always carries medusa_sync in (ERPNext → Medusa, Both)", () => {
        expect(withSelectionFilter([["disabled", "=", 0]], "Item", LIST)).toEqual([
            ["disabled", "=", 0],
            ["medusa_sync", "in", [DIRECTION_ERPNEXT_TO_MEDUSA, DIRECTION_BOTH]],
        ])
        expect(withSelectionFilter(null, "Item", LIST)).toEqual([
            ["medusa_sync", "in", [DIRECTION_ERPNEXT_TO_MEDUSA, DIRECTION_BOTH]],
        ])
    })

    it("does not repeat a clause the operator already wrote", () => {
        expect(withSelectionFilter([["medusa_sync", "=", DIRECTION_BOTH]], "Item", LIST)).toEqual([
            ["medusa_sync", "=", DIRECTION_BOTH],
        ])
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

    it("defaults the field to Both in deny mode and blank in allow mode", () => {
        expect(selectionDefault("deny")).toBe(DIRECTION_BOTH)
        expect(selectionDefault("allow")).toBe("")
    })
})

describe("reading the direction off a document", () => {
    it("knows the three values, treats anything else as not selected, and notices a missing field", () => {
        expect(selectionOf({ medusa_sync: DIRECTION_ERPNEXT_TO_MEDUSA })).toBe("erpnext_to_medusa")
        expect(selectionOf({ medusa_sync: DIRECTION_MEDUSA_TO_ERPNEXT })).toBe("medusa_to_erpnext")
        expect(selectionOf({ medusa_sync: DIRECTION_BOTH })).toBe("both")
        expect(selectionOf({ medusa_sync: "" })).toBe("none")
        expect(selectionOf({ medusa_sync: null })).toBe("none")
        expect(selectionOf({ medusa_sync: 1 })).toBe("none")
        expect(selectionOf({})).toBe("absent")
        expect(selectionOf(null)).toBe("absent")
        expect(parseRecordDirection(` ${DIRECTION_BOTH} `)).toBe("both")
    })

    it("ERPNext → Medusa and Both pull; Medusa → ERPNext and Both push", () => {
        expect(allowsPull("erpnext_to_medusa")).toBe(true)
        expect(allowsPull("both")).toBe(true)
        expect(allowsPull("medusa_to_erpnext")).toBe(false)
        expect(allowsPull("none")).toBe(false)
        expect(allowsPush("medusa_to_erpnext")).toBe(true)
        expect(allowsPush("both")).toBe(true)
        expect(allowsPush("erpnext_to_medusa")).toBe(false)
        expect(allowsPush("none")).toBe(false)
    })
})

describe("a document only narrows its mapping", () => {
    it("intersects the mapping's direction with the document's", () => {
        expect(effectiveDirection("both", "both")).toBe("both")
        expect(effectiveDirection("both", "erpnext_to_medusa")).toBe("pull")
        expect(effectiveDirection("both", "medusa_to_erpnext")).toBe("push")
        expect(effectiveDirection("both", "none")).toBe("none")
        expect(effectiveDirection("pull", "both")).toBe("pull")
        expect(effectiveDirection("pull", "medusa_to_erpnext")).toBe("none")
        expect(effectiveDirection("push", "erpnext_to_medusa")).toBe("none")
        expect(effectiveDirection("push", "both")).toBe("push")
    })

    it("a document without the field narrows nothing", () => {
        expect(effectiveDirection("both", "absent")).toBe("both")
        expect(effectiveDirection("push", "absent")).toBe("push")
    })
})

describe("whether a push may leave for a record", () => {
    it("a record ERPNext showed as ERPNext → Medusa never pushes", () => {
        const verdict = pushAllowedByRecord({ remote_direction: DIRECTION_ERPNEXT_TO_MEDUSA })
        expect(verdict.allowed).toBe(false)
        if (verdict.allowed === false) expect(verdict.reason).toMatch(/record-direction/)
    })

    it("a deselected record never pushes either", () => {
        expect(pushAllowedByRecord({ remote_direction: "" }).allowed).toBe(false)
        expect(pushAllowedByRecord({ remote_direction: null }).allowed).toBe(false)
    })

    it("Medusa → ERPNext and Both push; a record ERPNext has never seen is the mapping's call", () => {
        expect(pushAllowedByRecord({ remote_direction: DIRECTION_MEDUSA_TO_ERPNEXT }).allowed).toBe(true)
        expect(pushAllowedByRecord({ remote_direction: DIRECTION_BOTH }).allowed).toBe(true)
        expect(pushAllowedByRecord(null).allowed).toBe(true)
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

describe("what the hourly reconcile does with a linked document", () => {
    it("keeps one still moving ERPNext → Medusa, drafts a deselected or missing one, leaves a Medusa-owned one alone", () => {
        expect(reconcileDecision(DIRECTION_ERPNEXT_TO_MEDUSA)).toBe("keep")
        expect(reconcileDecision(DIRECTION_BOTH)).toBe("keep")
        expect(reconcileDecision("")).toBe("draft")
        expect(reconcileDecision(null)).toBe("draft")
        expect(reconcileDecision(undefined)).toBe("draft")
        expect(reconcileDecision(DIRECTION_MEDUSA_TO_ERPNEXT)).toBe("owned")
    })
})
