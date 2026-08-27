import { MedusaContainer } from "@medusajs/framework/types"
import { ERPNEXT_MODULE } from "../modules/erpnext"

/**
 * Daily prune of `erpnext_sync_event`.
 *
 * Nothing pruned this table before, so it grew without bound. That was
 * fine at 67 rows but it is not a policy — and the rows carry the
 * transformed payload, which on a Customer mapping means names, emails
 * and KYC identifiers. An unbounded event log is a second, unmanaged
 * copy of personal data that nobody remembers is there.
 *
 * Retention is configurable (`erpnext_setting.log_retention_days`,
 * default 180) so operators keep well past the three months they need
 * to answer "did this ever sync, and what happened" while still having
 * a defensible deletion date. 0 disables pruning entirely — a
 * deliberate choice, not the default.
 *
 * Runs at 03:20 IST, after the 02:00 Docker maintenance window so the
 * two don't contend for I/O.
 */
export default async function pruneSyncEvents(container: MedusaContainer) {
    const erpnext: any = container.resolve(ERPNEXT_MODULE)
    try {
        const outcome = await erpnext.pruneSyncEvents()
        if (outcome.deleted > 0) {
            console.log(
                `[erpnext-prune] deleted ${outcome.deleted} sync event(s) older than ` +
                    `${outcome.retention_days} days (cutoff ${outcome.cutoff})`,
            )
        }
    } catch (err: any) {
        console.error("[erpnext-prune] failed:", err?.message ?? err)
    }
}

export const config = {
    name: "erpnext-prune-sync-events",
    schedule: "20 21 * * *", // 03:20 IST
}
