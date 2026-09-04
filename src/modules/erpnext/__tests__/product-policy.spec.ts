import { describe, expect, it } from "vitest"
import {
    DEFAULT_PRODUCT_POLICY,
    decideProductPush,
    isLinked,
    linkedItemCode,
    normalizeProductPolicy,
} from "../product-policy"

describe("product policy", () => {
    it("defaults to link-only", () => {
        // ERPNext owns the catalogue: nothing is invented there by default.
        expect(DEFAULT_PRODUCT_POLICY).toBe("link")
        expect(normalizeProductPolicy(undefined)).toBe("link")
        expect(normalizeProductPolicy("")).toBe("link")
        expect(normalizeProductPolicy("nonsense")).toBe("link")
    })

    it("reads the three settings", () => {
        expect(normalizeProductPolicy("off")).toBe("off")
        expect(normalizeProductPolicy("CREATE")).toBe("create")
        expect(normalizeProductPolicy("link")).toBe("link")
    })

    it("off stops everything, linked or not", () => {
        expect(decideProductPush({ policy: "off", event: "product.created", linked: false })).toEqual({
            allow: false,
            reason: "product-policy-off",
        })
        expect(decideProductPush({ policy: "off", event: "product.updated", linked: true })).toEqual({
            allow: false,
            reason: "product-policy-off",
        })
    })

    it("link-only refuses a product with nowhere to land", () => {
        expect(decideProductPush({ policy: "link", event: "product.created", linked: false })).toEqual({
            allow: false,
            reason: "product-policy-link-required",
        })
    })

    it("link-only lets a linked product keep in step", () => {
        // The policy governs bringing a NEW product across, not keeping a
        // known one up to date.
        expect(decideProductPush({ policy: "link", event: "product.updated", linked: true })).toEqual({
            allow: true,
        })
        expect(decideProductPush({ policy: "link", event: "product.created", linked: true })).toEqual({
            allow: true,
        })
    })

    it("create allows an unlinked product through", () => {
        expect(decideProductPush({ policy: "create", event: "product.created", linked: false })).toEqual({
            allow: true,
        })
    })
})

describe("the link a product carries", () => {
    it("reads the item code out of metadata", () => {
        expect(linkedItemCode({ metadata: { erpnext_item_code: "PIX-001" } })).toBe("PIX-001")
        expect(isLinked({ metadata: { erpnext_item_code: "PIX-001" } })).toBe(true)
    })

    it("treats blank, missing and non-string as unlinked", () => {
        expect(linkedItemCode(null)).toBeNull()
        expect(linkedItemCode({})).toBeNull()
        expect(linkedItemCode({ metadata: {} })).toBeNull()
        expect(linkedItemCode({ metadata: { erpnext_item_code: "   " } })).toBeNull()
        expect(linkedItemCode({ metadata: { erpnext_item_code: 42 } })).toBeNull()
        expect(isLinked({ metadata: { erpnext_item_code: "" } })).toBe(false)
    })

    it("trims what an operator typed", () => {
        expect(linkedItemCode({ metadata: { erpnext_item_code: "  PIX-001 " } })).toBe("PIX-001")
    })
})
