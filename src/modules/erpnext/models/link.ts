import { model } from "@medusajs/framework/utils"

/**
 * `erpnext_link` — which Medusa record an ERPNext document became.
 *
 * Written after every successful pull or webhook upsert, read whenever an
 * ERPNext document goes away (deselected, trashed, renamed) so the right
 * product is drafted even when the mapping's key would no longer find it.
 * This is the map medusync used to keep in its own `Medusync Link`
 * DocType; it lives here now because ERPNext no longer runs anything of
 * ours.
 *
 * `state` is "active" while the document is selected and "drafted" once
 * we took the product off sale for it. A drafted link that is selected
 * again republishes the same product rather than making a twin.
 * `remote_direction` is the document's `medusa_sync` as ERPNext last
 * showed it.
 */
export const ErpnextLink = model.define("erpnext_link", {
    id: model.id().primaryKey(),

    /** Frappe DocType, e.g. "Item". */
    doctype: model.text(),

    /** The document's `name` in ERPNext. */
    erpnext_name: model.text(),

    /** Registry entity key, e.g. "product". */
    medusa_entity: model.text(),

    /** The Medusa record id. */
    medusa_id: model.text(),

    /** The mapping that made the link, when known. */
    mapping_id: model.text().nullable(),

    /** "active" | "drafted" */
    state: model.text().default("active"),

    /** The document's `medusa_sync` value as ERPNext last showed it —
     *  which way the document moves. Read before a push leaves. */
    remote_direction: model.text().nullable(),

    /** Last time ERPNext showed us this document selected. */
    last_seen_at: model.dateTime().nullable(),
})
