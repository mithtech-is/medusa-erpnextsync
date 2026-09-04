import { MedusaContainer } from "@medusajs/framework/types"
import { ERPNEXT_MODULE } from "../modules/erpnext"

/**
 * F3 — retry cron for failed erpnext_sync_event rows.
 *
 * Every 5 minutes, scan rows where:
 *   - status = "failed"
 *   - attempts < auto_retry_max_attempts (per settings)
 *   - last_attempt_at < now() - auto_retry_min_interval_minutes
 *
 * For each, re-dispatch:
 *   - direction='outbound' → forwardEvent({event, event_id, data})
 *   - direction='inbound'  → dispatchInbound (replay handler)
 *
 * Marks rows that exceed max_attempts as `status=poison` so they
 * stop being retried (the admin Replay button is the only way out
 * for poison rows — operator action required).
 *
 * This is the Tier-2.B mitigation from the architecture plan:
 *   Tier 1 (Frappe inline retry) catches network blips < 12s
 *   Tier 2.B (this cron)         catches Medusa restarts + handler
 *                                bugs (5–60min)
 *   Tier 2.D (reconciliation)    catches anything Tier 1+2.B missed
 */
export default async function retryEvents(container: MedusaContainer) {
    const erpnext: any = container.resolve(ERPNEXT_MODULE)
    let cfg: any = null
    try {
        cfg = await erpnext.getSettingsView()
    } catch {
        return
    }
    if (!cfg.auto_retry_failed) return // operator turned off retries

    const maxAttempts = cfg.auto_retry_max_attempts ?? 5
    const minIntervalMs = (cfg.auto_retry_min_interval_minutes ?? 15) * 60_000
    const cutoff = new Date(Date.now() - minIntervalMs)

    let candidates: any[] = []
    try {
        candidates = await erpnext.listFailedForRetry(50)
    } catch (err: any) {
        console.warn("[erpnext-retry] list failed:", err?.message)
        return
    }
    // When the breaker has given up on ERPNext, this run sends exactly
    // one row — somebody has to knock, or it never learns the far side
    // came back — and leaves the rest of the queue where it is. The
    // alternative is fifty timeouts every five minutes for an afternoon.
    let breakerOpen = true
    try {
        breakerOpen = !(await erpnext.breakerState()).tripped
    } catch {
        /* if we cannot read it, behave as though nothing is wrong */
    }
    let probeSpent = false

    let processed = 0
    let recovered = 0
    let poisoned = 0
    for (const row of candidates) {
        if (!breakerOpen) {
            if (probeSpent) break
            probeSpent = true
        }
        const attempts = row.attempts ?? 0
        if (attempts >= maxAttempts) {
            // Mark poison so it stops cycling. Operator must press
            // the Replay button to release.
            try {
                await erpnext.updateErpnextSyncEvents([
                    { id: row.id, status: "poison" },
                ])
                poisoned += 1
            } catch {
                /* swallow */
            }
            continue
        }
        if (row.last_attempt_at && new Date(row.last_attempt_at) > cutoff) {
            continue // not enough time has passed
        }
        try {
            if (row.direction === "inbound") {
                // For inbound, we can replay the payload (we already
                // verified the HMAC the first time around). Bypass
                // signature check by calling dispatch directly. Pass the
                // cron `container` as the handler scope — without it the
                // inbound handlers can't resolve the customer/wallet
                // modules and return `{skipped: "no_scope"}`, which this
                // loop would then mark "recovered" without doing the
                // work (silently dropping genuinely-failed inbound rows).
                const result = await erpnext.dispatchInbound?.(
                    row.event,
                    row.payload,
                    row.event_id,
                    container,
                )
                if (result && !result.skipped) {
                    await erpnext.updateErpnextSyncEvents([
                        {
                            id: row.id,
                            status: "success",
                            succeeded_at: new Date(),
                            last_error: null,
                            attempts: attempts + 1,
                            last_attempt_at: new Date(),
                        },
                    ])
                    recovered += 1
                }
            } else {
                // Tell forwardEvent this is the knock, so the breaker
                // lets it past itself.
                const result = await erpnext.retryEvent(row.event_id, undefined, {
                    probe: !breakerOpen,
                })
                if (result?.ok) recovered += 1
            }
            processed += 1
        } catch (err: any) {
            console.warn(
                `[erpnext-retry] row ${row.id} crashed:`,
                err?.message,
            )
        }
    }
    if (processed > 0 || poisoned > 0) {
        console.log(
            `[erpnext-retry] tick done — processed=${processed} ` +
                `recovered=${recovered} poisoned=${poisoned}`,
        )
    }
}

export const config = {
    name: "erpnext-retry-events",
    // Every 5 minutes — fast enough that a transient Medusa restart
    // is auto-recovered before the operator notices.
    schedule: "*/5 * * * *",
}
