/**
 * A sync across several DocTypes.
 *
 * A mapping keeps one main DocType — the document the Medusa record IS on
 * the ERPNext side — and may name secondary DocTypes that hang off it: a
 * Contact or an Address linked to a Customer through their Links table, a
 * document that names the main one in a Link field. Each field pair says
 * which DocType it targets; a pair with no `erpnext_doctype` targets the
 * main one. Pushing writes the main document first, then one document per
 * secondary DocType found through its link (or created with the link set).
 * Pulling reads the linked documents and lays them under the main one by
 * DocType name, so a pair reads `Contact.first_name` as a dot path.
 *
 * Everything here is pure; the service does the reading and writing.
 */
import type { MappingFieldPair } from "./mapping-engine"

export type LinkKind = "field" | "dynamic_links"

export type SecondaryDoctype = {
    doctype: string
    /** "field": a Link field on the secondary document names the main one.
     *  "dynamic_links": the secondary document's `links` table (Dynamic
     *  Link rows) names the main one, as Contact and Address do. */
    link_kind: LinkKind
    /** The Link field, for kind "field". */
    link_field?: string | null
}

export function normalizeSecondaryDoctypes(raw: unknown, mainDoctype?: string | null): SecondaryDoctype[] {
    if (!Array.isArray(raw)) return []
    const main = String(mainDoctype ?? "").trim()
    const out: SecondaryDoctype[] = []
    const seen = new Set<string>()
    for (const r of raw) {
        const doctype = String(r?.doctype ?? "").trim()
        if (!doctype || doctype === main || seen.has(doctype)) continue
        const kind: LinkKind = String(r?.link_kind ?? "").toLowerCase() === "dynamic_links" ? "dynamic_links" : "field"
        const link_field = String(r?.link_field ?? "").trim()
        if (kind === "field" && !link_field) continue
        seen.add(doctype)
        out.push({ doctype, link_kind: kind, link_field: kind === "field" ? link_field : null })
    }
    return out
}

/** The DocType a pair targets. */
export function doctypeOfPair(pair: Pick<MappingFieldPair, "erpnext_doctype">, main: string): string {
    const dt = String(pair?.erpnext_doctype ?? "").trim()
    return dt || main
}

export function pairsForDoctype(pairs: MappingFieldPair[], main: string, doctype: string): MappingFieldPair[] {
    return (pairs ?? []).filter((p) => doctypeOfPair(p, main) === doctype)
}

/** Pairs grouped by the DocType they target; the main one first. */
export function splitPairsByDoctype(pairs: MappingFieldPair[], main: string): Map<string, MappingFieldPair[]> {
    const out = new Map<string, MappingFieldPair[]>([[main, []]])
    for (const p of pairs ?? []) {
        const dt = doctypeOfPair(p, main)
        if (!out.has(dt)) out.set(dt, [])
        out.get(dt)!.push(p)
    }
    return out
}

/**
 * The pairs as the pull reads them: a secondary pair's ERPNext side
 * becomes a dot path into the linked document laid under the main one
 * (`Contact.first_name`). A pair with no ERPNext field is left alone.
 */
export function pairsForPull(pairs: MappingFieldPair[], main: string): MappingFieldPair[] {
    return (pairs ?? []).map((p) => {
        const dt = doctypeOfPair(p, main)
        if (dt === main || !p.erpnext_field) return p
        const { erpnext_doctype: _dt, ...rest } = p
        return { ...rest, erpnext_field: `${dt}.${p.erpnext_field}` }
    })
}

/** Frappe list filters that find the secondary document tied to the main one. */
export function secondaryLookupFilters(sec: SecondaryDoctype, mainDoctype: string, mainName: string): any[] {
    if (sec.link_kind === "dynamic_links") {
        return [
            ["Dynamic Link", "link_doctype", "=", mainDoctype],
            ["Dynamic Link", "link_name", "=", mainName],
        ]
    }
    return [[String(sec.link_field), "=", mainName]]
}

/** What a new secondary document carries so ERPNext ties it to the main one. */
export function secondaryLinkPayload(sec: SecondaryDoctype, mainDoctype: string, mainName: string): Record<string, any> {
    if (sec.link_kind === "dynamic_links") {
        return { links: [{ link_doctype: mainDoctype, link_name: mainName }] }
    }
    return { [String(sec.link_field)]: mainName }
}

/** The main document a secondary document points at, from its own fields. */
export function mainNameFromSecondaryDoc(sec: SecondaryDoctype, mainDoctype: string, doc: any): string | null {
    if (sec.link_kind === "dynamic_links") {
        const rows: any[] = Array.isArray(doc?.links) ? doc.links : []
        const hit = rows.find((r) => String(r?.link_doctype ?? "") === mainDoctype && r?.link_name)
        return hit ? String(hit.link_name) : null
    }
    const v = doc?.[String(sec.link_field)]
    return v == null || v === "" ? null : String(v)
}

/** The field the plugin fills on a secondary document to tie it to the main one. */
export function linkFieldFilled(sec: SecondaryDoctype): string {
    return sec.link_kind === "dynamic_links" ? "links" : String(sec.link_field)
}
