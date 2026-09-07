import type { MappingDirection, MappingFieldPair } from "./mapping-engine"

/**
 * A mapping is one configuration that lives in two systems.
 *
 * Editing it in the Medusa admin and editing it in the Frappe Desk have
 * to mean the same thing, so each mapping carries a `mapping_uid` shared
 * by both copies and a `version` that increments on every save. A change
 * on either side travels as `mapping.upserted`.
 *
 * Conflict rule: the higher version wins. On a tie ERPNext wins, because
 * ERPNext owns which documents are allowed to sync at all, and the two
 * decisions must not disagree. Everything here is pure so the rule can be
 * tested without a database.
 */

/** The shape that travels on the wire, identical from either side. */
export type CanonicalMapping = {
    uid: string
    version: number
    name: string
    enabled: boolean
    medusa_entity: string
    doctype: string
    /** Written from Medusa's point of view: "push" = Medusa → ERPNext. */
    direction: "push" | "pull" | "both"
    key_medusa_field: string
    key_erpnext_field: string
    source_of_truth?: string
    site_id?: string | null
    /**
     * Why it is off — present only when it is off and the sender said
     * why. The receiver shows it rather than a switch that went off by
     * itself. "Mapping Required" or "Field Missing".
     */
    attention?: string | null
    attention_detail?: string | null
    fields: Array<{
        medusa_path: string
        erpnext_field: string
        direction: "push" | "pull" | "both" | "none"
        transform?: string | null
        /** A fixed value written to `erpnext_field`, with no source on the
         *  other side. Absent on an ordinary pair. */
        constant?: unknown
    }>
}

export type ConflictDecision =
    | { apply: true; reason: "new" | "newer_version" }
    | { apply: false; reason: "stale_version" | "tie_erpnext_wins" | "missing_uid" }

/**
 * Decide whether an incoming mapping replaces the local copy.
 *
 * `localVersion` is null when we hold no copy under this uid.
 *
 * The tie is the interesting case. Two sides that both "win" a tie would
 * swap edits forever; two sides that both yield would silently diverge.
 * ERPNext wins, so from here an equal version is refused.
 */
export function decideConflict(
    localVersion: number | null,
    incomingVersion: number,
): ConflictDecision {
    if (localVersion == null) return { apply: true, reason: "new" }
    if (incomingVersion > localVersion) return { apply: true, reason: "newer_version" }
    if (incomingVersion < localVersion) return { apply: false, reason: "stale_version" }
    return { apply: false, reason: "tie_erpnext_wins" }
}

/** Normalise a stored direction into the canonical vocabulary. */
export function normalizeDirection(value: unknown): CanonicalMapping["direction"] {
    const v = String(value ?? "both").toLowerCase()
    return v === "push" || v === "pull" ? (v as "push" | "pull") : "both"
}

export function normalizeFieldDirection(
    value: unknown,
): CanonicalMapping["fields"][number]["direction"] {
    const v = String(value ?? "both").toLowerCase()
    if (v === "push" || v === "pull" || v === "none") return v
    return "both"
}

/** An `erpnext_mapping` row → the canonical form. */
export function toCanonical(row: Record<string, any>): CanonicalMapping {
    const fields: MappingFieldPair[] = Array.isArray(row.field_mappings) ? row.field_mappings : []
    return {
        uid: row.mapping_uid,
        version: Number(row.version ?? 1),
        name: row.name ?? "",
        enabled: row.enabled !== false,
        medusa_entity: row.medusa_entity ?? "",
        doctype: row.doctype ?? "",
        direction: normalizeDirection(row.direction),
        key_medusa_field: row.key_medusa_field ?? "",
        key_erpnext_field: row.key_erpnext_field ?? "name",
        source_of_truth: row.source_of_truth ?? "ERPNext",
        site_id: row.site_id ?? null,
        ...(row.enabled === false && row.attention
            ? { attention: row.attention, attention_detail: row.attention_detail ?? null }
            : {}),
        fields: fields.map((f) => ({
            medusa_path: f.medusa_path,
            erpnext_field: f.erpnext_field,
            direction: normalizeFieldDirection(f.direction),
            ...(f.constant !== undefined ? { constant: f.constant } : {}),
            transform: f.transform ?? null,
        })),
    }
}

/**
 * The canonical form → the columns of an `erpnext_mapping` row.
 *
 * `events` is deliberately absent: which Medusa events fire a push is a
 * Medusa-side concern the Frappe copy has no opinion on, so an inbound
 * mapping never clears it.
 */
export function fromCanonical(canon: CanonicalMapping): Record<string, any> {
    return {
        mapping_uid: canon.uid,
        version: Number(canon.version ?? 1),
        name: canon.name,
        enabled: canon.enabled !== false,
        medusa_entity: canon.medusa_entity,
        doctype: canon.doctype,
        direction: normalizeDirection(canon.direction),
        key_medusa_field: canon.key_medusa_field || canon.key_erpnext_field || "name",
        key_erpnext_field: canon.key_erpnext_field || "name",
        source_of_truth: canon.source_of_truth ?? "ERPNext",
        site_id: canon.site_id ?? null,
        // Off over there with a reason: off here, same reason. On over
        // there: whatever we said is moot, unless our own gate says
        // otherwise, which applyMappingConfig settles after this.
        ...(canon.enabled === false && canon.attention
            ? {
                  attention: canon.attention === "Field Missing" ? "Field Missing" : "Mapping Required",
                  attention_detail: canon.attention_detail ?? null,
              }
            : canon.enabled !== false
              ? { attention: null, attention_detail: null }
              : {}),
        field_mappings: (canon.fields ?? []).map((f) => ({
            medusa_path: f.medusa_path,
            erpnext_field: f.erpnext_field,
            direction: normalizeFieldDirection(f.direction),
            ...(f.constant !== undefined ? { constant: f.constant } : {}),
            transform: f.transform ?? null,
        })),
    }
}

// ── Identity: a sync is its pair ─────────────────────────────────────

/** A mapping's identity is derived from what it pairs, so both systems
 *  agree which mapping is which without asking each other. */
export const PAIR_PREFIX = "pair:"

/** `Sales Invoice (Return)` → `sales_invoice_return`, the same on both sides. */
export function scrubDoctype(doctype: string): string {
    return String(doctype ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
}

/**
 * One Medusa entity and one DocType, per store, is one mapping. The
 * Frappe app derives the same string (`mapping_sync.pair_uid`), so a
 * mapping created on either side lands on the other as itself rather
 * than as a twin.
 */
export function pairUid(entity: string, doctype: string, siteId?: string | null): string {
    const base = `${PAIR_PREFIX}${String(entity ?? "").trim().toLowerCase()}:${scrubDoctype(doctype)}`
    return siteId ? `${base}:${siteId}` : base
}

export function pairUidOf(row: {
    medusa_entity: string
    doctype: string
    site_id?: string | null
}): string {
    return pairUid(row.medusa_entity, row.doctype, row.site_id ?? null)
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
