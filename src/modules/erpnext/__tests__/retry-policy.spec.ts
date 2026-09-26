import { describe, expect, it } from "vitest"
import { owedRetry, supersededByLater } from "../retry-policy"

describe("owedRetry", () => {
    it("retries a failed or pending row in either direction, never a skip or a rehearsal", () => {
        expect(owedRetry({ status: "failed", direction: "outbound" })).toBe(true)
        expect(owedRetry({ status: "pending", direction: "inbound" })).toBe(true)
        expect(owedRetry({ status: "skipped", direction: "outbound" })).toBe(false)
        expect(owedRetry({ status: "success", direction: "outbound" })).toBe(false)
        expect(owedRetry({ status: "failed", direction: "outbound", is_test: true })).toBe(false)
    })
})

describe("supersededByLater", () => {
    const older = { id: "a", entity_ref: "order:o1", mapping_id: "m1", created_at: "2026-09-26T10:00:00Z", status: "failed" }
    it("is superseded by a newer row for the same record and mapping", () => {
        const newer = { id: "b", entity_ref: "order:o1", mapping_id: "m1", created_at: "2026-09-26T10:05:00Z", status: "failed" }
        expect(supersededByLater(older, [older, newer])).toBe(true)
        expect(supersededByLater(newer, [older, newer])).toBe(false)
    })
    it("is not superseded by another mapping, another record, an inbound row or an older row", () => {
        expect(supersededByLater(older, [{ id: "c", entity_ref: "order:o1", mapping_id: "m2", created_at: "2026-09-26T11:00:00Z" }])).toBe(false)
        expect(supersededByLater(older, [{ id: "d", entity_ref: "order:o2", mapping_id: "m1", created_at: "2026-09-26T11:00:00Z" }])).toBe(false)
        expect(supersededByLater(older, [{ id: "e", entity_ref: "order:o1", mapping_id: "m1", direction: "inbound", created_at: "2026-09-26T11:00:00Z" }])).toBe(false)
        expect(supersededByLater(older, [{ id: "f", entity_ref: "order:o1", mapping_id: "m1", created_at: "2026-09-26T09:00:00Z" }])).toBe(false)
    })
    it("never supersedes a row with no record reference or mapping", () => {
        expect(supersededByLater({ id: "g", status: "failed", created_at: "2026-09-26T10:00:00Z" }, [{ id: "h", created_at: "2026-09-26T11:00:00Z" }])).toBe(false)
    })
})
