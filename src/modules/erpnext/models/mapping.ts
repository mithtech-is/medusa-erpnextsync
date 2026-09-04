import { model } from "@medusajs/framework/utils"

/**
 * `erpnext_mapping` — operator-defined sync rule pairing one Medusa
 * entity with one Frappe doctype, with a field-by-field mapping and
 * direction toggles.
 *
 * Replaces the earlier hard-coded "customer.* → medusync.api.receive"
 * pipeline with a generic, configurable mapper.
 *
 * Identity:
 *   `name` is operator-facing label (e.g. "Customer → ERPNext Customer").
 *   `(medusa_entity, doctype)` is NOT unique — an operator might want
 *   two flows for the same pair with different filters (e.g.
 *   B2B vs B2C Customers landing in different Frappe customer groups).
 *
 * Direction:
 *   Three layers of direction control, applied left-to-right:
 *     1. `direction` on the row — overall toggle. "push" means Medusa
 *        events trigger writes to Frappe. "pull" means the pull cron
 *        reads from Frappe and writes to Medusa. "both" enables both.
 *     2. `events` JSON array — which Medusa event names cause a push.
 *        Empty/null = no push subscription (use for pull-only rows).
 *     3. Per-field `direction` inside `field_mappings` — fine-grained
 *        override. A field can be `pull`-only (read from Frappe but
 *        never overwritten by Medusa) even on a `both` mapping. This
 *        is how we model "Frappe owns canonical name" vs "Medusa owns
 *        canonical email" without forking the row into two.
 *
 * Identity correlation:
 *   `key_medusa_field` + `key_erpnext_field` are the dot-path / Frappe
 *   fieldname pair used to find the same record across systems. On
 *   push: the value extracted from the Medusa source becomes the
 *   `name` used in the Frappe upsert URL. On pull: the value read
 *   from the Frappe doc is matched against Medusa records by the
 *   sync engine.
 *
 * Field mappings JSON shape:
 *   [
 *     {
 *       medusa_path: "email",                     // dot-path
 *       erpnext_field: "email_id",                // Frappe fieldname
 *       direction: "both",                        // override (optional)
 *       transform: "lowercase",                   // optional
 *       default: null,                            // optional
 *       required: true                            // skip whole sync if missing
 *     },
 *     { medusa_path: "first_name", erpnext_field: "customer_name", ... }
 *   ]
 *
 * State:
 *   `last_pull_at` is the high-water-mark for the pull cron's
 *   incremental `modified > X` filter. NULL = next pull is a full scan.
 *
 *   `last_pull_error` / `last_push_error` are truncated to 1KB to give
 *   the admin UI a one-shot reason without bloating the row.
 */
export const ErpnextMapping = model.define("erpnext_mapping", {
    id: model.id().primaryKey(),

    /** Operator label, free text. */
    name: model.text(),

    /**
     * The id this mapping has in BOTH systems.
     *
     * The same mapping exists as a Medusync Mapping on the ERPNext side.
     * Edits can start from either, so the two copies are paired by this
     * uid and ordered by `version`: the higher version wins, and on a tie
     * ERPNext wins, because ERPNext owns which documents may sync at all.
     */
    mapping_uid: model.text().nullable(),

    /** Increments on every local save. Compared against the incoming
     *  version to decide whose copy is newer. */
    version: model.number().default(1),

    /** Which Medusa site this mapping belongs to. Empty means it applies
     *  wherever this instance is pointed. */
    site_id: model.text().nullable(),

    /** Which side wins when the same record changed on both. */
    source_of_truth: model.text().default("ERPNext"),

    /** Last time this mapping's CONFIGURATION was reconciled with the
     *  other side, not the last time a record synced through it. */
    last_synced_at: model.dateTime().nullable(),

    /** Optional notes for ops — "owned by accounting", "do not touch",
     *  upstream ticket links, etc. */
    description: model.text().nullable(),

    /** Master toggle. Disabled rows are inert: no push, no pull, no
     *  inclusion in the events-list filter. */
    enabled: model.boolean().default(true),

    /** Medusa entity identifier — "customer", "order", "product",
     *  "user", or any future addition wired into the entity registry.
     *  See modules/erpnext/registry.ts. */
    medusa_entity: model.text().searchable(),

    /** Frappe doctype name as it appears in Desk, e.g. "Customer",
     *  "Sales Invoice", "Item". Case-sensitive on the Frappe side. */
    doctype: model.text().searchable(),

    /** Overall flow direction. Per-field overrides live inside
     *  `field_mappings`. */
    direction: model.text().default("both"), // "push" | "pull" | "both"

    /** Medusa event names that fire this mapping on the push side.
     *  Stored as JSON array — empty / null = no push subscription. */
    events: model.json().nullable(),

    /** Frappe-side filter passed to the pull job, e.g.
     *    [["disabled", "=", 0], ["customer_group", "=", "Retail"]]
     *  Always combined with the time-based `modified > last_pull_at`
     *  guard at runtime. */
    pull_filter: model.json().nullable(),

    /** Page size for the pull job's per-tick query. Defaults to 200
     *  to fit comfortably under Frappe's resource limit (1000). */
    pull_page_size: model.number().default(200),

    /** Identity key pair — the dot-path on the Medusa side and the
     *  Frappe fieldname that hold the same logical value across the
     *  two systems. On push the Medusa value is used as the Frappe
     *  upsert key (typically the Frappe `name` field). */
    key_medusa_field: model.text(),
    key_erpnext_field: model.text().default("name"),

    /** Field-by-field mapping. See module-doc comment for shape. */
    field_mappings: model.json(),

    /** State — incremental pull cursor. NULL = next pull is a full
     *  scan; subsequent ticks advance it to the max(modified) of the
     *  rows just imported. */
    last_pull_at: model.dateTime().nullable(),
    last_pull_run_at: model.dateTime().nullable(),
    last_pull_error: model.text().nullable(),

    /** Loose summary for the admin UI — last_push_error captures the
     *  most recent push failure across ALL events triggered by this
     *  mapping. Per-event detail still lives in erpnext_sync_event. */
    last_push_run_at: model.dateTime().nullable(),
    last_push_error: model.text().nullable(),

    // ── Trigger ──────────────────────────────────────────────────────
    /**
     * WHEN this mapping fires, beyond simply matching an event name.
     *
     * `events` says which Medusa events are candidates; this says which
     * of those candidate records actually qualify. The distinction
     * matters: "customer.updated" fires constantly, but you may only
     * want the record in ERPNext once KYC clears, or once they've
     * actually bought something.
     *
     * Presets fill `trigger_condition` with a ready-made expression;
     * "custom" means the operator wrote their own. The preset is stored
     * (rather than inferred from the expression) so the UI can show
     * which one is selected without pattern-matching the text.
     */
    trigger_preset: model.text().default("always"),

    /**
     * Safe expression evaluated against the enriched record. Empty =
     * always fire. See modules/erpnext/trigger.ts for the grammar —
     * deliberately NOT JavaScript, so an operator-supplied string can
     * never execute arbitrary code inside the backend.
     */
    trigger_condition: model.text().nullable(),

    /**
     * Skip a push whose payload is byte-identical to the last one that
     * succeeded for the same record. Answers "only sync when something
     * a mapped field actually cares about changed" without needing the
     * previous document, which Medusa events don't carry.
     */
    skip_unchanged: model.boolean().default(false),

    // ── Write permissions ────────────────────────────────────────────
    /** May this mapping CREATE a record that doesn't exist on the
     *  other side? Off means updates-only — useful when the other
     *  system owns the population and you only enrich it. */
    allow_create: model.boolean().default(true),

    /** May this mapping UPDATE a record that already exists? Off means
     *  create-only, so an existing record is never overwritten. */
    allow_update: model.boolean().default(true),

    /** User id of the admin who last saved this row. */
    updated_by_user_id: model.text().nullable(),

    /**
     * Something about this mapping needs a person.
     *
     * "Mapping Required" — ERPNext enabled it and this side has not
     * rehearsed it, so it was left switched off. "Field Missing" — it
     * names an ERPNext field the DocType no longer has, so it cannot do
     * what it says and has been switched off.
     *
     * Empty when nothing is outstanding. Never part of the mapping's
     * signature: it is local state, like the rehearsal result.
     */
    attention: model.text().nullable(),
    attention_detail: model.text().nullable(),

    /**
     * Fingerprint of what this mapping did when it was last rehearsed.
     * The enable gate compares it with the mapping as it stands now, so a
     * pass survives being switched on and does not survive somebody
     * adding a field afterwards. See ../signature.ts.
     */
    tested_signature: model.text().nullable(),

    /**
     * Fingerprint of a shipped default as it was written, so an upgrade
     * can tell an untouched one from an edited one. Null for a mapping
     * somebody wrote.
     */
    shipped_signature: model.text().nullable(),

    last_test_at: model.dateTime().nullable(),
    /** "" | "passed" | "failed" */
    last_test_status: model.text().nullable(),
    last_test_report: model.json().nullable(),
})
