import type { MappingDirection, MappingFieldPair } from "./mapping-engine"

/**
 * A sync is its pair.
 *
 * One Medusa entity and one DocType is one mapping, whatever it is called
 * and however it was created, so the identity is derived from the pair
 * rather than generated. The unique index on `mapping_uid` and the fold
 * rules below keep two rows for one pair from surviving. Everything here
 * is pure.
 */

/** Normalise a stored direction into the canonical vocabulary. */
export function normalizeDirection(value: unknown): MappingDirection {
    const v = String(value ?? "both").toLowerCase()
    return v === "push" || v === "pull" ? (v as "push" | "pull") : "both"
}

export const PAIR_PREFIX = "pair:"

/** `Sales Invoice (Return)` → `sales_invoice_return`. */
export function scrubDoctype(doctype: string): string {
    return String(doctype ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
}

export function pairUid(entity: string, doctype: string): string {
    return `${PAIR_PREFIX}${String(entity ?? "").trim().toLowerCase()}:${scrubDoctype(doctype)}`
}

export function pairUidOf(row: { medusa_entity: string; doctype: string }): string {
    return pairUid(row.medusa_entity, row.doctype)
}

/** Union by Frappe field; the base wins a collision. */
export function mergeFieldPairs(
    base: MappingFieldPair[],
    extra: MappingFieldPair[],
): MappingFieldPair[] {
    const taken = new Set((base ?? []).map((p) => p.erpnext_field))
    return [
        ...(base ?? []),
        ...(extra ?? []).filter((p) => p.erpnext_field && !taken.has(p.erpnext_field)),
    ]
}

export function mergeEvents(a?: string[] | null, b?: string[] | null): string[] {
    const out: string[] = []
    for (const e of [...(a ?? []), ...(b ?? [])]) {
        if (e && !out.includes(e)) out.push(e)
    }
    return out
}

/**
 * Which of several mappings for one pair survives a fold: the higher
 * version, then the one that is switched on, then the older row. Returns
 * the index into `rows`.
 */
export function pickKeeper(
    rows: Array<{ version?: number | null; enabled?: boolean | null; created_at?: string | Date | null }>,
): number {
    const ts = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : Number.MAX_SAFE_INTEGER)
    let best = 0
    for (let i = 1; i < rows.length; i++) {
        const a = rows[i]
        const b = rows[best]
        const av = Number(a.version ?? 1)
        const bv = Number(b.version ?? 1)
        if (av !== bv) {
            if (av > bv) best = i
            continue
        }
        if (Boolean(a.enabled) !== Boolean(b.enabled)) {
            if (a.enabled) best = i
            continue
        }
        if (ts(a.created_at) < ts(b.created_at)) best = i
    }
    return best
}

/** Two mappings for one pair, folded: the same way stays, a one-way sync
 *  meeting its opposite becomes two-way. */
export function mergeDirection(
    a: MappingDirection | string | null | undefined,
    b: MappingDirection | string | null | undefined,
): MappingDirection {
    const x = normalizeDirection(a)
    const y = normalizeDirection(b)
    return x === y ? x : "both"
}
