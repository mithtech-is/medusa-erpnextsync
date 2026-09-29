/**
 * A product's GST rate, from its ERPNext Item.
 *
 * ERPNext taxes a line at the Item Tax Template it finds on the Item, and
 * failing that on the Item's group, then that group's parents
 * (`erpnext.stock.get_item_details.get_item_tax_template`). The store must
 * charge the same rate, so the Item pull records it on the product as a
 * Medusa tax-rate rule.
 *
 * Everything here is pure; the service does the reading and writing.
 */

export type ItemTaxRow = {
    item_tax_template?: string | null
    tax_category?: string | null
    valid_from?: string | null
    minimum_net_rate?: number | string | null
    maximum_net_rate?: number | string | null
}

function day(value: unknown): string {
    return String(value ?? "").slice(0, 10)
}

/**
 * The template ERPNext would pick from one taxes table, or null.
 * Rows of another company's template are ignored; dated rows win over
 * undated ones once their date has come, newest first; the row must be for
 * the document's tax category (blank for the store's documents). Rows
 * limited to a net-rate range are skipped: the store's documents never
 * carry one.
 */
export function templateFromRows(args: {
    rows: ItemTaxRow[] | null | undefined
    today: string
    company?: string | null
    companyOf?: (template: string) => string | null | undefined
    taxCategory?: string | null
}): string | null {
    const rows = (args.rows ?? []).filter((r) => r?.item_tax_template)
    const mine = rows.filter((r) => {
        if (!args.company || !args.companyOf) return true
        const c = args.companyOf(String(r.item_tax_template))
        return !c || c === args.company
    })
    const dated: ItemTaxRow[] = []
    const undated: ItemTaxRow[] = []
    for (const r of mine) {
        if (r.valid_from || Number(r.maximum_net_rate) > 0) {
            if (Number(r.maximum_net_rate) > 0 || Number(r.minimum_net_rate) > 0) continue
            if (day(r.valid_from) <= args.today) dated.push(r)
        } else undated.push(r)
    }
    const candidates = dated.length ? [...dated].sort((a, b) => day(b.valid_from).localeCompare(day(a.valid_from))) : undated
    const category = String(args.taxCategory ?? "")
    const hit = candidates.find((r) => String(r.tax_category ?? "") === category)
    return hit ? String(hit.item_tax_template) : null
}

/** The Item's own table first, then its group and the group's parents. */
export function effectiveItemTaxTemplate(args: {
    tables: Array<ItemTaxRow[] | null | undefined>
    today: string
    company?: string | null
    companyOf?: (template: string) => string | null | undefined
}): string | null {
    for (const rows of args.tables) {
        const hit = templateFromRows({ ...args, rows })
        if (hit) return hit
    }
    return null
}

export type RegionRate = {
    id: string
    rate: number | string | null
    is_default?: boolean | null
    code?: string | null
    rules?: Array<{ id?: string; reference?: string | null; reference_id?: string | null }> | null
}

export type ProductRulePlan = {
    /** The rate the product is charged at, in percent. */
    rate: number
    /** A non-default rate to create first, when none exists at this percentage. */
    create: { name: string; code: string; rate: number } | null
    /** The rate to add the product's rule to, or "created" for the one above; null for the default rate. */
    addTo: string | null
    /** Rule ids that put the product at another rate. */
    remove: string[]
}

export function gstRateCode(rate: number): string {
    return `GST${String(rate).replace(".", "_")}`
}

/**
 * The tax-rate rules that charge a product at `rate`. No rate (an Item
 * with no template) means the region's default, which is what ERPNext's
 * taxes template charges such a line.
 */
export function planProductTaxRule(args: {
    productId: string
    rate: number | null
    regionRates: RegionRate[]
}): ProductRulePlan {
    const rates = args.regionRates ?? []
    const fallback = rates.find((r) => r.is_default)
    const target = args.rate ?? (fallback ? Number(fallback.rate) : 0)
    const isDefault = Boolean(fallback) && Number(fallback!.rate) === target
    const existing = isDefault ? null : rates.find((r) => !r.is_default && Number(r.rate) === target) ?? null
    const remove: string[] = []
    let already = false
    for (const r of rates) {
        for (const rule of r.rules ?? []) {
            if (rule.reference !== "product" || rule.reference_id !== args.productId) continue
            if (existing && r.id === existing.id) already = true
            else if (rule.id) remove.push(rule.id)
        }
    }
    if (isDefault) return { rate: target, create: null, addTo: null, remove }
    if (existing) return { rate: target, create: null, addTo: already ? null : existing.id, remove }
    return {
        rate: target,
        create: { name: `GST ${target}%`, code: gstRateCode(target), rate: target },
        addTo: "created",
        remove,
    }
}
