/**
 * Canonical mapping definitions — the "starter pack" Mappings rows
 * the plugin seeds on first install, AND the suggestion source the
 * admin Mapping editor uses when the operator clicks "Suggest field
 * pairs".
 *
 * Why this file exists:
 *   - Without seed data, the Mappings tab is empty on first install
 *     and the operator has to hand-build every field pair.
 *   - The same data drives the auto-prefill in the editor: when the
 *     operator picks `entity=customer, doctype=Customer`, we look up
 *     the row here and offer to pre-fill `field_mappings`. They can
 *     edit or delete.
 *
 * This ships ONE neutral example (Customer ↔ Customer) against
 * standard ERPNext fields. It is a template, not a contract — add your
 * own rows per project (product ↔ Item, order ↔ Sales Invoice, or any
 * custom doctype), or build them field-by-field in the admin editor.
 *
 * Edit rules:
 *   - Every entry MUST have a `medusa_entity` matching a key from
 *     `registry.ts::listMedusaEntities`. The seeder skips entries
 *     with unknown entities (logs a warning).
 *   - `doctype` must exist on the connected Frappe instance, else
 *     the seeded row will exist but doctype-meta calls will 502.
 *     Verify against your target instance before adding new rows.
 *   - `field_mappings` is the SUGGESTED set, not the exhaustive set.
 *     Pick fields the operator is most likely to want — they can
 *     add more from the doctype field picker.
 *
 * Idempotency:
 *   The seeder upserts by `name`, so renaming an entry creates a
 *   second row. Pick names you don't intend to change.
 */
import type { MappingFieldPair, MappingDirection } from "./mapping-engine"

export type CanonicalMapping = {
    /** Unique stable name. Used as the upsert key. */
    name: string
    description: string
    enabled: boolean
    medusa_entity: string
    doctype: string
    direction: MappingDirection
    /** Events that trigger a push. Empty array = pull-only. */
    events: string[]
    pull_filter: any
    pull_page_size: number
    key_medusa_field: string
    key_erpnext_field: string
    field_mappings: MappingFieldPair[]
}

/**
 * Customer ↔ Customer.
 *
 * Neutral starter mapping against the standard ERPNext Customer
 * doctype. Medusa identifies a customer by email; ERPNext's Customer
 * carries `customer_name` as its required identity field. Adjust the
 * field pairs to whatever your Frappe instance actually exposes.
 */
const CUSTOMER_CUSTOMER: CanonicalMapping = {
    name: "Customer ↔ Customer",
    description:
        "Example bidirectional Customer sync between Medusa and Frappe. Keyed on email ↔ email_id. Edit the field pairs to match your Frappe Customer doctype (custom fields, KYC, etc.).",
    enabled: true,
    medusa_entity: "customer",
    doctype: "Customer",
    direction: "both",
    events: ["customer.created", "customer.updated", "customer.deleted"],
    pull_filter: [],
    pull_page_size: 200,
    key_medusa_field: "email",
    key_erpnext_field: "email_id",
    field_mappings: [
        { medusa_path: "email", erpnext_field: "email_id", direction: "both", transform: "lowercase" },
        { medusa_path: "phone", erpnext_field: "mobile_no", direction: "both" },
        { medusa_path: "first_name", erpnext_field: "customer_name", direction: "push" },
    ],
}

export const CANONICAL_MAPPINGS: CanonicalMapping[] = [
    CUSTOMER_CUSTOMER,
]

/**
 * Lookup helper used by the admin editor's "Suggest field pairs"
 * button. Returns the canonical mapping (if any) for an
 * `(entity, doctype)` pair so the UI can pre-fill `field_mappings`.
 *
 * Doctype match is case-insensitive (Frappe is case-sensitive in
 * URLs but operators often type lowercase). Returns null when no
 * canonical entry exists — the UI then offers a heuristic name-
 * matching fallback.
 */
export function findCanonicalMapping(
    entity: string,
    doctype: string,
): CanonicalMapping | null {
    const e = (entity || "").trim().toLowerCase()
    const d = (doctype || "").trim().toLowerCase()
    return (
        CANONICAL_MAPPINGS.find(
            (m) =>
                m.medusa_entity.toLowerCase() === e &&
                m.doctype.toLowerCase() === d,
        ) ?? null
    )
}
