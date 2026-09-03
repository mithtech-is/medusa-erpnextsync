import { model } from "@medusajs/framework/utils"

/**
 * `erpnext_setting` — singleton row for the Medusa-side ERPNext sync.
 *
 * Mirrors the `cashfree_setting` / `gamification_setting` / `ovo_setting`
 * pattern: a single row keyed by `singleton_key = "default"` so the
 * admin UI is one GET / one POST, with no list/pagination concerns.
 *
 * Why DB-stored (and not just env vars):
 *   - The Frappe side already has a `Medusa Settings` Single DocType
 *     that's editable from the desk. The Medusa side previously had
 *     only env vars, which meant any change required a redeploy and
 *     was invisible to operators. This row brings parity.
 *   - The forwarder reads from the row first and falls back to env
 *     vars (`ERPNEXT_URL`, `ERPNEXT_WEBHOOK_SECRET`) for bootstrap,
 *     so a fresh deploy still works even before an admin saves the
 *     settings page.
 *
 * Secret handling:
 *   - Stored as plaintext (same as `cashfree_setting.client_secret` /
 *     `webhook_secret`). The admin GET response masks them to a
 *     3-char prefix + 3-char suffix preview so a screenshot can't
 *     leak the value. Treat the DB + backups as sensitive.
 *   - The webhook secret MUST match
 *     `Medusa Settings → Medusa Webhook Secret` on the Frappe side,
 *     or HMAC verification will fail and webhooks will 401. The
 *     admin UI surfaces a "test connection" button that POSTs a
 *     ping event to validate the pair end-to-end.
 *
 * Toggle precedence (read by `getActiveConfig` in the service):
 *   row.enable_sync = false    → forwarder no-ops, rows are not even
 *                                logged (consistent with how the
 *                                Frappe side reads
 *                                `Medusa Settings.enable_sync`).
 *   row.erpnext_url unset      → fall back to ERPNEXT_URL env.
 *   row.webhook_secret unset   → fall back to ERPNEXT_WEBHOOK_SECRET.
 */
export const ErpnextSetting = model.define("erpnext_setting", {
    id: model.id().primaryKey(),
    /** Always "default" — enforces single-row semantics. The unique
     *  index on this column lives in the migration. */
    singleton_key: model.text().default("default"),

    /**
     * This Medusa instance's identity on the wire.
     *
     * One ERPNext can serve several Medusa stores; every envelope names
     * its site so the far side can tell them apart, keep their logs
     * separate, and recognise its own change coming home. Must equal the
     * Site ID of the matching Medusync Site record. Empty falls back to
     * "default", which is what a single-store install gets.
     */
    site_id: model.text().nullable(),

    // ── Master toggle ────────────────────────────────────────────────
    /** Kill switch. When false, `forwardEvent` short-circuits and
     *  doesn't write a row. Mirror of Frappe's `Medusa Settings.
     *  enable_sync`. */
    enable_sync: model.boolean().default(true),

    // ── Connection ───────────────────────────────────────────────────
    /** Base URL of the Frappe site running the sync app, e.g.
     *  `https://erp.example.com`. Trailing slash is stripped by
     *  the service before composing the receive endpoint. Empty →
     *  ERPNEXT_URL env is used. */
    erpnext_url: model.text().nullable(),

    /** Whitelisted Frappe method that receives Medusa→Frappe pushes,
     *  e.g. `medusync.api.receive`. The mapped-push path appends
     *  `_mapped`. Empty → ERPNEXT_RECEIVE_METHOD env, else the built-in
     *  default (`medusync.api.receive`). Lets one plugin talk to any
     *  Frappe app whose endpoint name differs. */
    frappe_receive_method: model.text().nullable(),

    /**
     * HMAC-SHA256 secret for Medusa→Frappe pushes (the "old"
     * webhook_secret). Sent as `x-medusa-signature` over the raw JSON
     * body. Must equal `Medusa Settings.medusa_webhook_secret` on
     * the Frappe side. Empty → ERPNEXT_WEBHOOK_SECRET env is used.
     *
     * NB column name stays `webhook_secret` for backwards-compat with
     * existing rows; semantically it's now `medusa_to_frappe_secret`.
     */
    webhook_secret: model.text().nullable(),

    /**
     * HMAC-SHA256 secret for Frappe→Medusa pushes (added F0). The
     * Frappe `Webhook` rows seeded by F2 sign every body with this
     * secret; the F1 inbound receiver verifies with the same value.
     *
     * Kept SEPARATE from `webhook_secret` so each direction can be
     * rotated independently — a leak on one side doesn't compromise
     * the other.
     */
    frappe_to_medusa_secret: model.text().nullable(),

    /** Optional: ERPNext API key/secret (Frappe `api_key:api_secret`)
     *  for any future case where Medusa needs to *call* ERPNext's
     *  whitelisted methods directly (currently it only POSTs to the
     *  webhook receiver, which is allow_guest + HMAC-verified, so
     *  these aren't required today). */
    erpnext_api_key: model.text().nullable(),
    erpnext_api_secret: model.text().nullable(),

    // ── HTTP behaviour ───────────────────────────────────────────────
    /** Per-request timeout in ms. Default 15s — tuned so a slow Frappe
     *  job has time to write a sync log row but the Medusa worker
     *  doesn't get pinned. */
    request_timeout_ms: model.number().default(15000),

    // ── Retry policy (read by the future retry cron) ─────────────────
    /** When true, a cron job auto-retries `failed` rows in
     *  `erpnext_sync_event`. Manual retry via the admin route is
     *  always available regardless of this flag. */
    auto_retry_failed: model.boolean().default(true),

    /** Stop retrying a row after this many total attempts. Prevents
     *  poison events from hammering ERPNext forever. */
    auto_retry_max_attempts: model.number().default(5),

    /** Minimum backoff floor in minutes between retries of the same
     *  event. The actual interval is exponential up to a cap; this
     *  is the smallest possible value. */
    auto_retry_min_interval_minutes: model.number().default(15),

    // ── Operational state ────────────────────────────────────────────
    /** Set when an admin clicks "Run full resync". Mirrors Frappe's
     *  `Medusa Settings.last_full_sync_at` on the other side, used
     *  for audit + as a soft cooldown. */
    last_full_resync_at: model.dateTime().nullable(),

    /**
     * Outbound safety valve. When non-empty, ONLY records whose
     * identity matches one of these entries are pushed to ERPNext;
     * everything else is skipped and logged as `not_in_allowlist`.
     *
     * Entries are newline- or comma-separated and matched
     * case-insensitively against the record's `id`, `email`, `handle`,
     * `display_id` and `metadata.isin`.
     *
     * Why this exists: pointing a production Medusa at a non-production
     * ERPNext is a normal thing to want while integrating, but it would
     * otherwise stream every customer's personal data onto that box. An
     * allowlist makes "sync these three test records and nothing else"
     * expressible without disabling sync entirely.
     *
     * EMPTY = no restriction (all records push). That's the historical
     * behaviour and stays the default.
     */
    push_allowlist: model.text().nullable(),

    /**
     * How long to keep `erpnext_sync_event` rows before the daily prune
     * deletes them. Defaults to 180 days — comfortably past the
     * three-month window operators need to answer "did this customer
     * ever sync, and what happened".
     *
     * 0 disables pruning entirely (keep forever). Sync events carry the
     * payload, which on a Customer mapping means personal data, so
     * "forever" is a deliberate choice rather than the default.
     */
    log_retention_days: model.number().default(180),

    /** Free-text ops notes — escalation contacts, known quirks, etc. */
    notes: model.text().nullable(),

    /** User id (admin) who last saved the row. Useful when triaging
     *  "who turned sync off at 3 AM". */
    updated_by_user_id: model.text().nullable(),
})
