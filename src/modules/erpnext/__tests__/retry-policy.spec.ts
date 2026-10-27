import { describe, expect, it } from "vitest"
import { orderEventSupersedes, owedRetry, supersededByLater } from "../retry-policy"

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
    const older = { id: "a", event: "order.placed", entity_ref: "order:o1", mapping_id: "m1", created_at: "2026-09-26T10:00:00Z", status: "failed" }
    it("is superseded by a newer row for the same record and mapping", () => {
        const newer = { id: "b", event: "order.placed", entity_ref: "order:o1", mapping_id: "m1", created_at: "2026-09-26T10:05:00Z", status: "failed" }
        expect(supersededByLater(older, [older, newer])).toBe(true)
        expect(supersededByLater(newer, [older, newer])).toBe(false)
    })
    it("is not superseded by another mapping, another record, an inbound row or an older row", () => {
        expect(supersededByLater(older, [{ id: "c", event: "order.placed", entity_ref: "order:o1", mapping_id: "m2", created_at: "2026-09-26T11:00:00Z" }])).toBe(false)
        expect(supersededByLater(older, [{ id: "d", entity_ref: "order:o2", mapping_id: "m1", created_at: "2026-09-26T11:00:00Z" }])).toBe(false)
        expect(supersededByLater(older, [{ id: "e", entity_ref: "order:o1", mapping_id: "m1", direction: "inbound", created_at: "2026-09-26T11:00:00Z" }])).toBe(false)
        expect(supersededByLater(older, [{ id: "f", entity_ref: "order:o1", mapping_id: "m1", created_at: "2026-09-26T09:00:00Z" }])).toBe(false)
    })
    it("still lets any newer row supersede one for a record that is not an order", () => {
        const customer = { id: "x", event: "customer.created", entity_ref: "customer:c1", mapping_id: "m3", created_at: "2026-09-26T10:00:00Z" }
        expect(supersededByLater(customer, [customer, { ...customer, id: "y", event: "customer.updated", created_at: "2026-09-26T10:01:00Z" }])).toBe(true)
    })
    it("never supersedes a row with no record reference or mapping", () => {
        expect(supersededByLater({ id: "g", status: "failed", created_at: "2026-09-26T10:00:00Z" }, [{ id: "h", created_at: "2026-09-26T11:00:00Z" }])).toBe(false)
    })
})

describe("an order's rows", () => {
    const at = (event: string, minute: number, status = "failed") => ({
        id: `${event}@${minute}`,
        event,
        status,
        entity_ref: "order:o2",
        mapping_id: "m1",
        created_at: `2026-10-10T10:${String(minute).padStart(2, "0")}:00Z`,
    })

    it("a paid order cancelled minutes later: placement and capture give way to the cancellation, which books them first", () => {
        const placed = at("order.placed", 0)
        const captured = at("order.payment_captured", 1)
        const canceled = at("order.canceled", 5, "success")
        const rows = [placed, captured, canceled]
        expect(supersededByLater(placed, rows)).toBe(true)
        expect(supersededByLater(captured, rows)).toBe(true)
        expect(supersededByLater(canceled, rows)).toBe(false)
    })

    it("a failed placement gives way to a later capture, which carries the newer order", () => {
        const placed = at("order.placed", 0)
        const captured = at("order.payment_captured", 1)
        expect(supersededByLater(placed, [placed, captured])).toBe(true)
        expect(supersededByLater(captured, [placed, captured])).toBe(false)
    })

    it("a refund supersedes nothing but an older refund, and nothing supersedes a cancellation but another", () => {
        const captured = at("order.payment_captured", 1)
        const refunded = at("order.payment_refunded", 3)
        const canceled = at("order.canceled", 2)
        expect(supersededByLater(captured, [captured, refunded])).toBe(false)
        expect(supersededByLater(refunded, [refunded, at("order.payment_refunded", 4)])).toBe(true)
        expect(supersededByLater(canceled, [canceled, at("order.placed", 6), refunded])).toBe(false)
        expect(supersededByLater(canceled, [canceled, at("order.canceled", 7)])).toBe(true)
    })

    it("a row with no event recorded is never superseded by a different one", () => {
        expect(orderEventSupersedes("order.placed", null)).toBe(false)
        expect(orderEventSupersedes(undefined, "order.placed")).toBe(false)
        expect(orderEventSupersedes("order.fulfillment_created", "order.payment_captured")).toBe(true)
    })
})
