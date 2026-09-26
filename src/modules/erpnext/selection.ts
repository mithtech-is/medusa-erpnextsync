/**
 * Which ERPNext documents belong in this store.
 *
 * One Check field, `medusa_sync` ("Sync to Medusa"), on every DocType that
 * holds catalogue documents. Ticked means "this one". The field is created
 * by "Set up ERPNext" (see ./erpnext-setup.ts); the two Frappe Webhooks it
 * installs fire on the field, and the pull always filters on it.
 *
 * Two ways to run it, chosen per DocType when the field is created:
 *   allow — the field defaults to 0; tick the few that should sync.
 *   deny  — the field defaults to 1; untick the exemptions. The column is
 *           created NOT NULL DEFAULT 1, so every existing document is
 *           ticked the moment the field exists.
 * Changing the mode later changes the default for NEW documents only.
 *
 * Everything here is pure so the rules can be tested without a database.
 */

export type SyncMode = "allow" | "deny"

export type SyncDoctype = { doctype: string; mode: SyncMode }

/** The Frappe fieldname. The Custom Field is named `<DocType>-medusa_sync`. */
export const SELECTION_FIELD = "medusa_sync"

/** What holds the catalogue when nobody has said otherwise. */
export const DEFAULT_CATALOGUE_DOCTYPE = "Item"

export const DEFAULT_SYNC_DOCTYPES: SyncDoctype[] = [
    { doctype: DEFAULT_CATALOGUE_DOCTYPE, mode: "allow" },
]

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
 * `["medusa_sync","=",1]`. Nothing is pulled from such a DocType without
 * it — if the field does not exist yet, Frappe refuses the query and the
 * pull reports it, which is the failure we want (run Set up ERPNext), not
 * a page of unselected documents.
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
    if (!present) out.push([SELECTION_FIELD, "=", 1])
    return out
}

/** "on" | "off" as the document says, "absent" when the field is not in the
 *  document at all — a DocType nobody has set up, or a body without it. */
export function selectionOf(doc: Record<string, any> | null | undefined): "on" | "off" | "absent" {
    if (!doc || typeof doc !== "object" || !(SELECTION_FIELD in doc)) return "absent"
    const v = (doc as any)[SELECTION_FIELD]
    if (v === 1 || v === true || v === "1") return "on"
    return "off"
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
