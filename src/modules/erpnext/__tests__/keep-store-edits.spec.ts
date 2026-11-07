import { describe, expect, it } from "vitest"
import { PULLED_KEY, keepStoreEdits } from "../registry"
import { protectedPaths } from "../mapping-engine"

const paths = ["title", "metadata.moq"]

function pulled(payload: Record<string, any>) {
    return keepStoreEdits(null, payload, paths).metadata[PULLED_KEY]
}

describe("keeping the store's edits on a pull", () => {
    it("reads which fields are protected off the mapping", () => {
        expect(protectedPaths([
            { medusa_path: "title", erpnext_field: "item_name", protect_edits: true },
            { medusa_path: "status", erpnext_field: "disabled" },
        ])).toEqual(["title"])
    })

    it("fills a blank field and remembers what it pulled", () => {
        const out = keepStoreEdits({ title: "", metadata: {} }, { title: "PUMP" }, paths)
        expect(out.title).toBe("PUMP")
        expect(out.metadata[PULLED_KEY].title).toBeTruthy()
    })

    it("keeps an edit made in the store while ERPNext's value has not changed", () => {
        const snapshot = pulled({ title: "PUMP" })
        const existing = { title: "Kirloskar pump", metadata: { [PULLED_KEY]: snapshot } }
        expect(keepStoreEdits(existing, { title: "PUMP" }, paths).title).toBeUndefined()
    })

    it("treats a difference with no history as the store's edit", () => {
        const out = keepStoreEdits({ title: "Enriched title", metadata: {} }, { title: "RAW" }, paths)
        expect(out.title).toBeUndefined()
        expect(out.metadata[PULLED_KEY].title).toBeTruthy()
    })

    it("lets ERPNext win once its own value changes", () => {
        const snapshot = pulled({ title: "PUMP" })
        const existing = { title: "Kirloskar pump", metadata: { [PULLED_KEY]: snapshot } }
        expect(keepStoreEdits(existing, { title: "PUMP MK2" }, paths).title).toBe("PUMP MK2")
    })

    it("protects a metadata key without touching its neighbours", () => {
        const out = keepStoreEdits({ metadata: { moq: 5 } }, { metadata: { moq: 0, uom: "Nos" } }, paths)
        expect(out.metadata.moq).toBeUndefined()
        expect(out.metadata.uom).toBe("Nos")
    })

    it("leaves a payload alone when nothing is protected", () => {
        const payload = { title: "PUMP" }
        expect(keepStoreEdits({ title: "x" }, payload, [])).toBe(payload)
    })
})
