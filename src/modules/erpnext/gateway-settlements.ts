/**
 * Payment-gateway settlements, booked in ERPNext.
 *
 * At capture each payment is received into its provider's Mode of Payment
 * account, a clearing account (order-accounting.ts). When the gateway pays
 * out, a settlement clears it in two documents:
 *   - a Purchase Invoice from the gateway for its fee, taxed the way
 *     India Compliance taxes a purchase from that supplier, paid at once
 *     from the clearing account so it never sits in payables;
 *   - a Journal Entry moving the net payout from the clearing account to
 *     the bank account it landed in.
 * Together they take gross - refunds + adjustments out of the clearing
 * account: what capture put in, less the refunds already unwound there.
 */

import { normalizePaymentModes } from "./order-accounting"

export const SETTLEMENT_EVENT = "payment_gateway.settlement_recorded"
/** The link table's entity for a settlement; its id is `<provider>:<settlement_id>`. */
export const SETTLEMENT_ENTITY = "gateway_settlement"

export const DEFAULT_SERVICE_ITEM = "Payment Gateway Charges"
/**
 * SAC for the gateway's fee on the service item Set up ERPNext creates.
 * A placeholder: the owner must confirm the code against the gateway's
 * own tax invoices before relying on it.
 */
export const DEFAULT_GATEWAY_SAC = "997158"

/** What the store buys from one gateway, and how the gateway is paid out. */
export type GatewaySupplier = {
    /** The ERPNext Supplier (its name or its supplier_name). */
    supplier: string
    /** The non-stock service Item the fee is billed as. */
    item: string
    /** HSN/SAC on that Item when Set up ERPNext creates it. */
    gst_hsn_code: string
    /** The Mode of Payment whose account the gateway's payments sit in;
     *  null finds it in the provider → Mode of Payment map. */
    mode_of_payment: string | null
}

export const DEFAULT_GATEWAY_SUPPLIERS: Readonly<Record<string, GatewaySupplier>> = Object.freeze({
    cashfree: {
        supplier: "Cashfree Payments India Private Limited",
        item: DEFAULT_SERVICE_ITEM,
        gst_hsn_code: DEFAULT_GATEWAY_SAC,
        mode_of_payment: null,
    },
})

/** The gateway → supplier map Settings holds; null means the default. */
export function normalizeGatewaySuppliers(raw: unknown): Record<string, GatewaySupplier> {
    let value = raw
    if (value === null || value === undefined) {
        return Object.fromEntries(Object.entries(DEFAULT_GATEWAY_SUPPLIERS).map(([k, v]) => [k, { ...v }]))
    }
    if (typeof value === "string") {
        try {
            value = JSON.parse(value)
        } catch {
            return {}
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return {}
    const text = (v: unknown) => (typeof v === "string" ? v.trim() : "")
    const out: Record<string, GatewaySupplier> = {}
    for (const [provider, entry] of Object.entries(value as Record<string, any>)) {
        const p = String(provider ?? "").trim().toLowerCase()
        const supplier = text(entry?.supplier)
        if (!p || !supplier) continue
        out[p] = {
            supplier,
            item: text(entry?.item) || DEFAULT_SERVICE_ITEM,
            gst_hsn_code: text(entry?.gst_hsn_code) || DEFAULT_GATEWAY_SAC,
            mode_of_payment: text(entry?.mode_of_payment) || null,
        }
    }
    return out
}

/**
 * The Mode of Payment a gateway's payments were received into. The
 * gateway's own row wins; else the provider → Mode of Payment map, under
 * the gateway's name or a Medusa provider id for it (`pp_cashfree-pg`
 * for "cashfree"). Two different modes for one gateway is no answer.
 */
export function modeForGateway(
    provider: string,
    gateway: GatewaySupplier | null | undefined,
    paymentModes: unknown,
): { ok: true; mode: string } | { ok: false; error: string } {
    if (gateway?.mode_of_payment) return { ok: true, mode: gateway.mode_of_payment }
    const modes = normalizePaymentModes(paymentModes)
    const p = String(provider ?? "").trim().toLowerCase()
    if (modes[p]) return { ok: true, mode: modes[p] }
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const pattern = new RegExp(`^pp_${escaped}([-_]|$)`, "i")
    const found = [...new Set(Object.entries(modes).filter(([id]) => pattern.test(id)).map(([, mode]) => mode))]
    if (found.length === 1) return { ok: true, mode: found[0] }
    if (found.length > 1) {
        return { ok: false, error: `payment providers for ${p} book to different Modes of Payment (${found.join(", ")}); name one on the gateway's row under Settings → Payments into ERPNext` }
    }
    return { ok: false, error: `no Mode of Payment for gateway ${p}; map it under Settings → Payments into ERPNext` }
}
