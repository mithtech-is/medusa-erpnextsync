import { describe, expect, it } from "vitest"
import { decideConflict, fromCanonical, toCanonical } from "../mapping-sync"

describe("mapping conflict rule", () => {
    it("accepts a mapping we have never seen", () => {
        expect(decideConflict(null, 1)).toEqual({ apply: true, reason: "new" })
    })

    it("accepts a higher version", () => {
        expect(decideConflict(2, 3)).toEqual({ apply: true, reason: "newer_version" })
    })

    it("refuses a lower version", () => {
        expect(decideConflict(3, 2)).toEqual({ apply: false, reason: "stale_version" })
    })

    it("gives ERPNext the tie", () => {
        // Both sides "winning" a tie would swap edits forever; both yielding
        // would diverge silently. ERPNext owns sync selection, so it wins.
        expect(decideConflict(2, 2)).toEqual({ apply: false, reason: "tie_erpnext_wins" })
    })
})

describe("canonical form", () => {
    const row = {
        mapping_uid: "uid-1",
        version: 4,
        name: "Customer ↔ Customer",
        enabled: true,
        medusa_entity: "customer",
        doctype: "Customer",
        direction: "both",
        key_medusa_field: "email",
        key_erpnext_field: "email_id",
        site_id: null,
        field_mappings: [
            { medusa_path: "email", erpnext_field: "email_id", direction: "both", transform: "lowercase" },
            { medusa_path: "thumbnail", erpnext_field: "image", direction: "none" },
            { medusa_path: "first_name", erpnext_field: "customer_name" },
        ],
    }

    it("carries identity, version and every field pair", () => {
        const canon = toCanonical(row)
        expect(canon.uid).toBe("uid-1")
        expect(canon.version).toBe(4)
        expect(canon.doctype).toBe("Customer")
        expect(canon.fields).toHaveLength(3)
        expect(canon.fields[0].transform).toBe("lowercase")
    })

    it("keeps Don't Sync as its own direction", () => {
        const canon = toCanonical(row)
        expect(canon.fields[1].direction).toBe("none")
    })

    it("defaults a pair with no direction to both", () => {
        expect(toCanonical(row).fields[2].direction).toBe("both")
    })

    it("survives a round trip", () => {
        const back = fromCanonical(toCanonical(row))
        expect(back.mapping_uid).toBe("uid-1")
        expect(back.version).toBe(4)
        expect(back.key_erpnext_field).toBe("email_id")
        expect(back.field_mappings[1].direction).toBe("none")
    })

    it("never carries the Medusa event list back over the wire", () => {
        // Which Medusa events fire a push is a Medusa-side concern; an
        // inbound mapping must not clear it.
        expect(fromCanonical(toCanonical(row))).not.toHaveProperty("events")
    })

    it("falls back to the ERPNext key when the Medusa half is missing", () => {
        const back = fromCanonical(toCanonical({ ...row, key_medusa_field: "" }))
        expect(back.key_medusa_field).toBe("email_id")
    })
})
