import type { MappingDirection } from "./mapping-engine"

/**
 * Which ERPNext documents belong in this store, and which way each moves.
 *
 * One Select field, `medusa_sync` ("Sync to Medusa"), on every DocType that
 * holds catalogue documents, with four values:
 *
 *   (blank)             not selected; nothing moves
 *   ERPNext → Medusa    ERPNext owns it; it is pulled and delivered here
 *   Medusa → ERPNext    Medusa owns it; it is pushed there (Phase 2)
 *   Both                moves both ways
 *
 * A document's value can only NARROW what its mapping allows: a pull-only
 * mapping never pushes a "Both" document, and a "ERPNext → Medusa"
 * document is never pushed by a two-way mapping. `effectiveDirection` is
 * that intersection.
 *
 * Two ways to run it, chosen per DocType when the field is created:
 *   allow — the field defaults to blank; select the few that should sync.
 *   deny  — the field defaults to "Both"; every existing document is
 *           selected the moment the field exists.
 * Changing the mode later changes the default for NEW documents only.
 *
 * Everything here is pure so the rules can be tested without a database.
 */

export type SyncMode = "allow" | "deny"

export type SyncDoctype = { doctype: string; mode: SyncMode }

/** The Frappe fieldname. The Custom Field is named `<DocType>-medusa_sync`. */
export const SELECTION_FIELD = "medusa_sync"

/** The Select's option strings, exactly as stored on the document. */
export const DIRECTION_ERPNEXT_TO_MEDUSA = "ERPNext → Medusa"
export const DIRECTION_MEDUSA_TO_ERPNEXT = "Medusa → ERPNext"
export const DIRECTION_BOTH = "Both"

export const SELECTION_OPTIONS = [
    "",
    DIRECTION_ERPNEXT_TO_MEDUSA,
    DIRECTION_MEDUSA_TO_ERPNEXT,
    DIRECTION_BOTH,
] as const

/** Values under which ERPNext → Medusa (webhooks, pull) applies. */
export const PULL_VALUES = [DIRECTION_ERPNEXT_TO_MEDUSA, DIRECTION_BOTH] as const

/** Values under which Medusa → ERPNext (push) applies. */
export const PUSH_VALUES = [DIRECTION_MEDUSA_TO_ERPNEXT, DIRECTION_BOTH] as const

/** What holds the catalogue when nobody has said otherwise. */
export const DEFAULT_CATALOGUE_DOCTYPE = "Item"

export const DEFAULT_SYNC_DOCTYPES: SyncDoctype[] = [
    { doctype: DEFAULT_CATALOGUE_DOCTYPE, mode: "allow" },
]

/** The field's default for new documents in each mode. */
export function selectionDefault(mode: SyncMode): string {
    return mode === "deny" ? DIRECTION_BOTH : ""
}

/** Coerce whatever the settings row or the admin form holds into a clean
 *  list: trimmed doctype names, no duplicates, mode defaulting to allow. */
export function normalizeSyncDoctypes(raw: unknown): SyncDoctype[] {
    const out: SyncDoctype[] = []
    const seen = new Set<string>()
    const rows = Array.isArray(raw) ? raw : []
    for (const row of rows) {
        const doctype =
            typeof row === "string"
                ? row.trim()
                : String((row as any)?.doctype ?? "").trim()
        if (!doctype || seen.has(doctype)) continue
        seen.add(doctype)
        const mode = String((row as any)?.mode ?? "allow").toLowerCase() === "deny" ? "deny" : "allow"
        out.push({ doctype, mode })
    }
    return out
}

export function isSyncDoctype(doctype: string, list: SyncDoctype[] | null | undefined): boolean {
    const wanted = String(doctype ?? "").trim()
    return Boolean(wanted) && (list ?? []).some((d) => d.doctype === wanted)
}

/**
 * The pull filter for a selection DocType always carries
 * `["medusa_sync","in",["ERPNext → Medusa","Both"]]`. Nothing is pulled
 * from such a DocType without it — if the field does not exist yet,
 * Frappe refuses the query and the pull reports it, which is the failure
 * we want (run Set up ERPNext), not a page of unselected documents.
 */
export function withSelectionFilter(
    filters: any[] | null | undefined,
    doctype: string,
    list: SyncDoctype[] | null | undefined,
): any[] {
    const out = Array.isArray(filters) ? [...filters] : []
    if (!isSyncDoctype(doctype, list)) return out
    const present = out.some(
        (f) => Array.isArray(f) && String(f[0]) === SELECTION_FIELD,
    )
    if (!present) out.push([SELECTION_FIELD, "in", [...PULL_VALUES]])
    return out
}

/** A document's direction as the plugin reasons about it. */
export type RecordDirection =
    | "erpnext_to_medusa"
    | "medusa_to_erpnext"
    | "both"
    /** Selected by nobody: blank, null, or a value the field never offered. */
    | "none"
    /** The document carries no `medusa_sync` key at all — a DocType nobody
     *  has set up, or a body without it. */
    | "absent"

/** The stored value → a direction. Anything the Select never offered is "none". */
export function parseRecordDirection(value: unknown): Exclude<RecordDirection, "absent"> {
    const v = String(value ?? "").trim()
    if (v === DIRECTION_ERPNEXT_TO_MEDUSA) return "erpnext_to_medusa"
    if (v === DIRECTION_MEDUSA_TO_ERPNEXT) return "medusa_to_erpnext"
    if (v === DIRECTION_BOTH) return "both"
    return "none"
}

export function selectionOf(doc: Record<string, any> | null | undefined): RecordDirection {
    if (!doc || typeof doc !== "object" || !(SELECTION_FIELD in doc)) return "absent"
    return parseRecordDirection((doc as any)[SELECTION_FIELD])
}

/** May this document move ERPNext → Medusa? */
export function allowsPull(d: RecordDirection): boolean {
    return d === "erpnext_to_medusa" || d === "both"
}

/** May this document move Medusa → ERPNext? */
export function allowsPush(d: RecordDirection): boolean {
    return d === "medusa_to_erpnext" || d === "both"
}

/**
 * What a mapping may do with one document: the mapping's direction
 * narrowed by the document's. A document never widens a mapping.
 *
 * "absent" is a document with no field — a DocType outside selection —
 * and narrows nothing; the mapping alone decides.
 */
export function effectiveDirection(
    mapping: MappingDirection | string | null | undefined,
    record: RecordDirection,
): MappingDirection | "none" {
    const m = String(mapping ?? "both").toLowerCase()
    const canPush = (m === "push" || m === "both") && (record === "absent" || allowsPush(record))
    const canPull = (m === "pull" || m === "both") && (record === "absent" || allowsPull(record))
    if (canPush && canPull) return "both"
    if (canPush) return "push"
    if (canPull) return "pull"
    return "none"
}

/**
 * May a push for this Medusa record leave? The link table remembers the
 * direction ERPNext last showed for the document it became; a record
 * nobody has seen over there yet has no link and is the mapping's and the
 * product policy's to decide.
 */
export function pushAllowedByRecord(
    link: { remote_direction?: string | null } | null | undefined,
): { allowed: true } | { allowed: false; reason: string } {
    // No link, or a link whose document ERPNext has never shown us a
    // direction for (made by hand, or pulled from a DocType outside
    // selection): nothing to narrow by.
    if (!link || link.remote_direction === null || link.remote_direction === undefined) return { allowed: true }
    const d = parseRecordDirection(link.remote_direction)
    if (allowsPush(d)) return { allowed: true }
    return {
        allowed: false,
        reason:
            d === "none"
                ? "record-direction: not selected for sync in ERPNext"
                : `record-direction: set to "${DIRECTION_ERPNEXT_TO_MEDUSA}" in ERPNext`,
    }
}

/**
 * What the hourly reconcile does with one linked document, given the
 * `medusa_sync` value ERPNext reports for it now — or `undefined` when
 * ERPNext no longer has a document of that name (trashed, renamed).
 *
 *   keep   — still moving ERPNext → Medusa; note the value, touch nothing
 *   owned  — Medusa → ERPNext: Medusa's own record, never drafted
 *   draft  — deselected or gone: the product comes off sale
 */
export function reconcileDecision(value: unknown | undefined): "keep" | "owned" | "draft" {
    if (value === undefined) return "draft"
    const d = parseRecordDirection(value)
    if (allowsPull(d)) return "keep"
    if (d === "medusa_to_erpnext") return "owned"
    return "draft"
}

/**
 * Which DocType "link this product to an existing document" searches.
 * The enabled product mapping says so; failing that, the first selection
 * DocType; failing that, Item.
 */
export function resolveProductsDoctype(
    list: SyncDoctype[] | null | undefined,
    mappings: Array<{ medusa_entity?: string; doctype?: string; enabled?: boolean }> | null | undefined,
): string {
    const fromMapping = (mappings ?? []).find(
        (m) => m?.medusa_entity === "product" && m?.enabled !== false && m?.doctype,
    )
    if (fromMapping?.doctype) return String(fromMapping.doctype)
    if (list?.length) return list[0].doctype
    return DEFAULT_CATALOGUE_DOCTYPE
}
