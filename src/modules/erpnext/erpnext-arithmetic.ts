/**
 * ERPNext's own arithmetic for a sales document, so the store can charge
 * exactly what ERPNext will invoice before the document exists.
 *
 * It follows `erpnext/controllers/taxes_and_totals.py` for the documents
 * this plugin writes:
 * - lines at a net rate (a line discount is already inside the rate)
 * - the GST rows of a taxes template, each line at its Item Tax Template's rate
 * - shipping as one `Actual` row ahead of the GST rows, which are then
 *   "On Previous Row Total" of it, so shipping is spread over the lines by
 *   net amount and taxed at each line's rate (India Compliance's
 *   `update_taxable_values` reads it the same way)
 *
 * Money is floats, as in Python; the operations run in the same order so
 * the doubles come out the same.
 */

/**
 * Frappe's `flt(value, precision)` under the "Banker's Rounding" method
 * (`frappe.utils.data._bankers_rounding`): half to even, with a tolerance
 * of one unit in the last place for values that are a half in decimal but
 * not in binary.
 */
export function frappeRound(num: number, precision: number): number {
    if (!Number.isFinite(num) || num === 0) return 0
    const sign = num < 0 ? -1 : 1
    const multiplier = 10 ** precision
    let n = Number((Math.abs(num) * multiplier).toFixed(12))
    if (n === 0) return 0
    const floor = Math.floor(n)
    const decimal = n - floor
    const epsilon = 2 ** (Math.log2(n) - 52)
    if (epsilon < 0.5 && Math.abs(decimal - 0.5) < epsilon) n = floor % 2 === 0 ? floor : floor + 1
    else n = Math.round(n)
    return (sign * n) / multiplier
}

export type EstimateLine = {
    /** Net unit rate as sent to ERPNext (price less the line's discount), to the paisa. */
    rate: number
    qty: number
    /** The line's GST rate in percent (its Item Tax Template's). */
    gstRate: number
}

export type SalesEstimate = {
    netTotal: number
    /** Tax rows in document order: the shipping row when there is one, then GST. */
    taxes: number[]
    gstTotal: number
    grandTotal: number
    /** What the customer pays: the grand total rounded to the rupee, or the grand total when rounding is off. */
    payable: number
    roundingAdjustment: number
}

/**
 * The totals ERPNext will compute. `interState` decides whether GST is one
 * IGST row or a CGST and an SGST row at half the rate each; the split only
 * matters because ERPNext rounds each row on its own.
 */
export function estimateSalesTotals(args: {
    lines: EstimateLine[]
    shipping: number
    interState: boolean
    roundTotal: boolean
}): SalesEstimate {
    const lines = args.lines.map((l) => {
        const amount = frappeRound(frappeRound(l.rate, 2) * l.qty, 2)
        return { net: amount, gstRate: Number(l.gstRate) || 0 }
    })
    let netTotal = 0
    for (const l of lines) netTotal += l.net
    netTotal = frappeRound(netTotal, 2)

    const gstRowShares = args.interState ? [1] : [0.5, 0.5]
    const shipping = frappeRound(args.shipping, 2)
    const taxes: number[] = []
    // The base each GST row applies to, per line: its net amount, plus its
    // share of the shipping when shipping is a row of its own.
    let bases = lines.map((l) => l.net)
    if (shipping > 0) {
        let remaining = shipping
        bases = lines.map((l, i) => {
            let share = netTotal ? (l.net * shipping) / netTotal : 0
            remaining -= share
            if (i === lines.length - 1) share += remaining
            return l.net + share
        })
        taxes.push(shipping)
    }
    for (const part of gstRowShares) {
        let row = 0
        lines.forEach((l, i) => {
            row += ((l.gstRate * part) / 100) * bases[i]
        })
        taxes.push(frappeRound(row, 2))
    }

    let total = netTotal
    for (const t of taxes) total = frappeRound(total + t, 2)
    const grandTotal = frappeRound(total, 2)
    const payable = args.roundTotal ? frappeRound(grandTotal, 0) : grandTotal
    const gstTotal = frappeRound(taxes.slice(shipping > 0 ? 1 : 0).reduce((s, t) => s + t, 0), 2)
    return {
        netTotal,
        taxes,
        gstTotal,
        grandTotal,
        payable,
        roundingAdjustment: frappeRound(payable - grandTotal, 2),
    }
}
