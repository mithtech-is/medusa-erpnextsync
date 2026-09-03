import { model } from "@medusajs/framework/utils"

/**
 * `erpnext_sync_event` — durable log of every Medusa-side event we tried
 * to forward to the ERPNext (Frappe) sync app.
 *
 * Why this exists:
 * The previous fire-and-forget subscriber dropped events on the floor if
 * ERPNext was down or rate-limited. The Frappe-side hourly reconciler
 * (the configured Frappe reconcile method) is the safety net for *missed* events,
 * but it can't tell us *which specific webhooks failed* and why. This
 * table makes the failure surface visible (admin UI: GET /admin/erpnext/
 * events) and gives us a knob to manually retry without waiting for the
 * next reconcile tick.
 *
 * Identity:
 *   `event_id` is Medusa's `event.id` — used to dedupe and to correlate
 *   with rows in Frappe's `Medusa Sync Log` (which records the same id
 *   on the receiving side). One row per Medusa event id.
 *
 * Lifecycle:
 *   pending  → row created right before the HTTP POST
 *   success  → 2xx response within 15s
 *   failed   → non-2xx, network error, or timeout
 *   skipped  → ERPNEXT_URL / ERPNEXT_WEBHOOK_SECRET not configured at
 *              forward time (we don't even attempt the POST)
 *
 * `attempts` counts every retry (including the initial send). The admin
 * "retry" route increments it and resets the row to `pending` before
 * re-attempting.
 */
export const ErpnextSyncEvent = model.define("erpnext_sync_event", {
    id: model.id().primaryKey(),

    /**
     * Who caused this row: `<system>:<site_id>`, e.g. "erpnext:default".
     * On an inbound row it is the sender; on an outbound row it is empty
     * unless the push was itself caused by an inbound write.
     */
    origin: model.text().nullable(),

    /** Carried unchanged through a causal chain, so one customer edit can
     *  be followed across both systems in the logs. */
    correlation_id: model.text().nullable(),

    /**
     * `<entity>:<id>` of the Medusa record an INBOUND write touched.
     *
     * This is the breadcrumb that stops a sync loop. An inbound write
     * lands as an ordinary module write; the event it triggers reaches the
     * forward subscriber moments later, in another request, where no
     * in-memory flag survives. Finding a recent inbound row for the same
     * entity tells the push it is an echo, and it is stamped so the far
     * side drops it.
     */
    entity_ref: model.text().nullable(),

    /** Which site this row belongs to. */
    site_id: model.text().nullable(),

    /** Medusa event name, e.g. "customer.created", "order.placed". */
    event: model.text().index(),

    /** Medusa's event.id — unique per event firing. Indexed for dedupe
     *  lookups in `forwardEvent`. */
    event_id: model.text().searchable(),

    /** Enriched payload as forwarded — kept verbatim so a future retry
     *  doesn't have to re-fetch from the customer/order modules (which
     *  may have changed shape since the original fire). */
    payload: model.json().nullable(),

    /**
     * One of: "pending" | "success" | "failed" | "skipped".
     * Stored as text rather than enum so adding new states later (e.g.
     * "rate_limited") doesn't require a migration.
     */
    status: model.text().default("pending"),

    /** Total attempt count. Incremented on every send + every retry. */
    attempts: model.number().default(0),

    /** Timestamp of the most recent attempt (success or fail). */
    last_attempt_at: model.dateTime().nullable(),

    /** Timestamp of the first 2xx response. Stays set on subsequent
     *  retries that no-op (idempotent on the Frappe side). */
    succeeded_at: model.dateTime().nullable(),

    /** Truncated to 1KB. HTTP status + response body, or the JS error
     *  message if the request never completed. */
    last_error: model.text().nullable(),

    /** The full URL we POSTed to. Mostly for debugging when ERPNEXT_URL
     *  changes — old failed rows still show what they were aimed at. */
    target_url: model.text().nullable(),

    /** Mapping row that produced this forward. NULL for legacy-path
     *  forwards (where no mapping matched and the subscriber used the
     *  catch-all enriched payload). Indexed via partial unique. */
    mapping_id: model.text().nullable(),

    /**
     * Sync direction. "outbound" = Medusa→Frappe (the only kind that
     * existed pre-F1); "inbound" = Frappe→Medusa POSTed by a standard
     * Frappe Webhook row (created via the seeder). The retry +
     * reconciliation crons scan by (status, direction) so this column
     * is indexed in the migration.
     */
    direction: model.text().default("outbound"),

    /**
     * What the sync actually DID on the far side — "created",
     * "updated", "skipped" or null when it never got that far. The
     * status column says whether the call succeeded; this says what it
     * changed, which is the question an operator triaging "why is this
     * customer missing in ERPNext" is really asking.
     */
    action: model.text().nullable(),

    /**
     * SHA-256 of the transformed payload. Lets a mapping with
     * `skip_unchanged` recognise a repeat of a push it already made,
     * without keeping the previous document around. Indexed with
     * mapping_id because that is how the lookup queries it.
     */
    payload_hash: model.text().nullable(),
})
