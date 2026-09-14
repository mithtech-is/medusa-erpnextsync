import { describe, expect, it } from "vitest"
import { handleFromKey } from "../registry"

/**
 * An ERP item code is a part number, not a slug. Medusa rejects a handle
 * that is not URL-safe, so the whole catalogue depends on this deriving
 * something valid and — more importantly — stable.
 */
describe("the handle an item code becomes", () => {
    it("keeps a code that is already url safe recognisable", () => {
        expect(handleFromKey("ELE-CAB-ARM")).toBe("ele-cab-arm")
    })

    it("survives the punctuation a real part number carries", () => {
        expect(handleFromKey("ELE-CAB-ARM-COPPER-2.50 SQMM-3 CORE")).toBe(
            "ele-cab-arm-copper-2-50-sqmm-3-core",
        )
        expect(handleFromKey("CABLE-TRAYMETAL-100X50(WTCOVER)")).toBe(
            "cable-traymetal-100x50-wtcover",
        )
        expect(handleFromKey("A/1 B")).toBe("a-1-b")
    })

    it("never ends or starts on a separator", () => {
        expect(handleFromKey("  (spaced)  ")).toBe("spaced")
        expect(handleFromKey("---x---")).toBe("x")
    })

    it("gives the same answer every time, or the sync would duplicate products", () => {
        const code = "ELE-CAB-ARM-COPPER-2.50 SQMM-3 CORE"
        expect(handleFromKey(code)).toBe(handleFromKey(code))
    })

    it("still produces a handle when the code is nothing but punctuation", () => {
        const h = handleFromKey("///")
        expect(h).toMatch(/^item-[0-9a-f]{8}$/)
        expect(handleFromKey("///")).toBe(h)
    })

    it("stays within a sane length", () => {
        expect(handleFromKey("X".repeat(400)).length).toBeLessThanOrEqual(120)
    })

    it("treats an empty or missing code as punctuation rather than throwing", () => {
        expect(handleFromKey("")).toMatch(/^item-[0-9a-f]{8}$/)
        expect(handleFromKey(undefined as any)).toMatch(/^item-[0-9a-f]{8}$/)
    })
})
