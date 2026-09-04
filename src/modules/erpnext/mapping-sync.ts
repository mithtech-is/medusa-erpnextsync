import type { MappingFieldPair } from "./mapping-engine"

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
    fields: Array<{
        medusa_path: string
        erpnext_field: string
        direction: "push" | "pull" | "both" | "none"
        transform?: string | null
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
        fields: fields.map((f) => ({
            medusa_path: f.medusa_path,
            erpnext_field: f.erpnext_field,
            direction: normalizeFieldDirection(f.direction),
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
        field_mappings: (canon.fields ?? []).map((f) => ({
            medusa_path: f.medusa_path,
            erpnext_field: f.erpnext_field,
            direction: normalizeFieldDirection(f.direction),
            transform: f.transform ?? null,
        })),
    }
}
