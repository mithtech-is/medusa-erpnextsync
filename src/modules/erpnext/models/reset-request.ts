import { model } from "@medusajs/framework/utils"

/**
 * `erpnext_reset_request` — one attempt at a two-sided hard reset.
 *
 * The audit record, not the mechanism. Everything that decides whether a
 * reset may happen lives in `../reset.ts`, where the four rules that
 * matter — long enough, short-lived, single use, compared in constant
 * time — can be read and tested in one place.
 *
 * This exists so that afterwards there is something to point at saying
 * who asked, when, whether both sides proved themselves, and what was
 * actually done. It survives the reset it describes: a reset that erased
 * its own record would be the one thing nobody could investigate.
 */
export const ErpnextResetRequest = model.define("erpnext_reset_request", {
    id: model.id().primaryKey(),

    /** Which connected ERPNext this reset is between. */
    site_id: model.text().nullable(),

    /** pending | verified | completed | cancelled | expired | failed */
    status: model.text().default("pending"),

    /**
     * SHA-256 of the secret this side generated, hex. The plaintext is
     * returned once, to the operator who asked, and is stored nowhere:
     * not here, not in `erpnext_sync_event`, not in a log line.
     */
    secret_hash: model.text().nullable(),

    /** Three minutes after the secret was shown. */
    expires_at: model.dateTime().nullable(),

    /** When the secret was spent. A secret works once. */
    used_at: model.dateTime().nullable(),

    /** Set when ERPNext proved it holds the secret THIS side generated. */
    local_verified_at: model.dateTime().nullable(),

    /** Set when this side proved to ERPNext that it holds ERPNext's secret. */
    remote_confirmed_at: model.dateTime().nullable(),

    completed_at: model.dateTime().nullable(),

    /** What was cleared and what was kept, written when the reset runs. */
    report: model.json().nullable(),
})
