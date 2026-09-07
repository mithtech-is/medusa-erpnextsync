import { describe, expect, it } from "vitest"
import {
    mergeEvents,
    mergeFieldPairs,
    pairUid,
    pairUidOf,
    pickKeeper,
    scrubDoctype,
} from "../mapping-sync"

/**
 * A sync is its pair. One Medusa entity and one DocType is one mapping,
 * whichever side created it and whatever it was called, so the identity
 * is derived from the pair rather than generated. `medusync/tests/
 * test_pair_identity.py` is the other half and derives the same strings.
 */
describe("the pair identity", () => {
    it("is derived from the entity and the doctype", () => {
        expect(pairUid("order", "Sales Order")).toBe("pair:order:sales_order")
    })

    it("includes the store when the mapping is pinned to one", () => {
        expect(pairUid("order", "Sales Order", "shop-1")).toBe("pair:order:sales_order:shop-1")
        expect(pairUid("order", "Sales Order", null)).toBe("pair:order:sales_order")
    })

    it("scrubs a doctype the same way the Frappe side does", () => {
        expect(scrubDoctype("Sales Invoice (Return)")).toBe("sales_invoice_return")
        expect(scrubDoctype("  Item ")).toBe("item")
    })

    it("reads the pair off a mapping row", () => {
        expect(pairUidOf({ medusa_entity: "product", doctype: "Item", site_id: null })).toBe(
            "pair:product:item",
        )
    })
})

describe("folding two mappings for one pair", () => {
    it("keeps the base's pair on a collision and appends the rest", () => {
        const merged = mergeFieldPairs(
            [
                { medusa_path: "email", erpnext_field: "email_id", direction: "both" },
                { medusa_path: "first_name", erpnext_field: "customer_name", direction: "push" },
            ],
            [
                { medusa_path: "phone", erpnext_field: "mobile_no", direction: "both" },
                { medusa_path: "display_name", erpnext_field: "customer_name", direction: "pull" },
            ],
        )
        expect(merged).toEqual([
            { medusa_path: "email", erpnext_field: "email_id", direction: "both" },
            { medusa_path: "first_name", erpnext_field: "customer_name", direction: "push" },
            { medusa_path: "phone", erpnext_field: "mobile_no", direction: "both" },
        ])
    })

    it("unions the events without repeating one", () => {
        expect(mergeEvents(["order.placed"], ["order.canceled", "order.placed"])).toEqual([
            "order.placed",
            "order.canceled",
        ])
        expect(mergeEvents(null, undefined)).toEqual([])
    })

    it("keeps the higher version, then the one that is switched on, then the older row", () => {
        const rows = [
            { version: 3, enabled: false, created_at: "2026-09-01" },
            { version: 7, enabled: false, created_at: "2026-09-05" },
            { version: 7, enabled: true, created_at: "2026-09-06" },
        ]
        expect(pickKeeper(rows)).toBe(2)
        expect(
            pickKeeper([
                { version: 1, enabled: false, created_at: "2026-09-06" },
                { version: 1, enabled: false, created_at: "2026-09-01" },
            ]),
        ).toBe(1)
    })
})
