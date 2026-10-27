import { describe, expect, it } from "vitest"
import { latestModified, modifiedAfter, watermarkDate } from "../pull-watermark"

describe("the pull watermark", () => {
    const modified = "2026-10-11 12:00:00.123456"

    it("stores Frappe's wall time as UTC, as it always has", () => {
        expect(watermarkDate(modified).toISOString()).toBe("2026-10-11T12:00:00.123Z")
        expect(watermarkDate("2026-10-11 12:00:00").toISOString()).toBe("2026-10-11T12:00:00.000Z")
    })

    it("starts after the exact record it stopped at, so the newest record is not pulled again", () => {
        const after = modifiedAfter(watermarkDate(modified), modified)
        expect(after).toBe(modified)
        // Frappe compares a datetime(6) column: the same record is not newer than itself.
        expect(modified > after!).toBe(false)
    })

    it("falls back to the stored instant, to the millisecond, when the exact value is missing or stale", () => {
        expect(modifiedAfter(new Date("2026-10-11T12:00:00.123Z"), null)).toBe("2026-10-11 12:00:00.123")
        expect(modifiedAfter(new Date("2026-10-11T13:00:00.000Z"), modified)).toBe("2026-10-11 13:00:00.000")
        expect(modifiedAfter("2026-10-11T12:00:00.123Z", modified)).toBe(modified)
    })

    it("reads everything when there is no watermark", () => {
        expect(modifiedAfter(null, modified)).toBeNull()
        expect(modifiedAfter(undefined, undefined)).toBeNull()
    })

    it("keeps the newest modified, microseconds included", () => {
        let max: string | null = null
        for (const m of ["2026-10-11 12:00:00.5", "2026-10-11 12:00:00.123456", "2026-10-11 12:00:00", null]) {
            max = latestModified(max, m)
        }
        expect(max).toBe("2026-10-11 12:00:00.5")
        expect(latestModified("2026-10-11 12:00:00.000001", "2026-10-11 12:00:00.000002")).toBe("2026-10-11 12:00:00.000002")
    })
})
