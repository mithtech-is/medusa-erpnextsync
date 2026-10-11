import { describe, expect, it } from "vitest"

import {
    DEFAULT_GATEWAY_SAC,
    DEFAULT_GATEWAY_SUPPLIERS,
    modeForGateway,
    normalizeGatewaySuppliers,
} from "../gateway-settlements"

describe("the gateway → supplier map", () => {
    it("defaults to Cashfree's supplier and a service item whose SAC is still to confirm", () => {
        expect(normalizeGatewaySuppliers(null)).toEqual({
            cashfree: {
                supplier: "Cashfree Payments India Private Limited",
                item: "Payment Gateway Charges",
                gst_hsn_code: "997158",
                mode_of_payment: null,
            },
        })
        expect(DEFAULT_GATEWAY_SAC).toBe("997158")
        expect(normalizeGatewaySuppliers(undefined)).toEqual(DEFAULT_GATEWAY_SUPPLIERS)
    })

    it("keeps rows with a supplier, fills the item and SAC, and lower-cases the gateway", () => {
        expect(
            normalizeGatewaySuppliers({
                Razorpay: { supplier: " Razorpay Software Pvt Ltd ", mode_of_payment: "Razorpay" },
                cashfree: { supplier: "" },
            }),
        ).toEqual({
            razorpay: {
                supplier: "Razorpay Software Pvt Ltd",
                item: "Payment Gateway Charges",
                gst_hsn_code: "997158",
                mode_of_payment: "Razorpay",
            },
        })
        expect(normalizeGatewaySuppliers("{bad")).toEqual({})
        expect(normalizeGatewaySuppliers({})).toEqual({})
    })
})

describe("the Mode of Payment a gateway was paid into", () => {
    const gateway = normalizeGatewaySuppliers(null).cashfree

    it("finds the Medusa provider id for the gateway in the provider map", () => {
        expect(modeForGateway("cashfree", gateway, { "pp_cashfree-pg": "Cashfree" })).toEqual({ ok: true, mode: "Cashfree" })
        expect(modeForGateway("cashfree", gateway, null)).toEqual({ ok: true, mode: "Cashfree" })
        expect(modeForGateway("cashfree", gateway, { cashfree: "Cashfree UPI" })).toEqual({ ok: true, mode: "Cashfree UPI" })
    })

    it("prefers the gateway's own row", () => {
        expect(modeForGateway("cashfree", { ...gateway, mode_of_payment: "CF Clearing" }, { "pp_cashfree-pg": "Cashfree" })).toEqual({
            ok: true,
            mode: "CF Clearing",
        })
    })

    it("refuses to guess between two modes, or when there is none", () => {
        const two = modeForGateway("cashfree", gateway, { "pp_cashfree-pg": "Cashfree", pp_cashfree_upi: "Cashfree UPI" })
        expect(two.ok).toBe(false)
        const none = modeForGateway("cashfree", gateway, { pp_cashfreex: "Other", "pp_razorpay-pg": "Razorpay" })
        expect(none).toEqual({ ok: false, error: "no Mode of Payment for gateway cashfree; map it under Settings → Payments into ERPNext" })
    })
})
