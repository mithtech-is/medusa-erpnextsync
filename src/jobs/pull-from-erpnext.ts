import { MedusaContainer } from "@medusajs/framework/types"
import { ERPNEXT_MODULE } from "../modules/erpnext"

/**
 * Pull-side sync cron.
 *
 * Every 5 minutes, walks every enabled mapping that has push direction
 * `pull` or `both` and asks Frappe for rows modified since the
 * mapping's `last_pull_at` cursor. Each row is transformed via the
 * mapping engine and upserted into Medusa through the entity
 * registry's adapter.
 *
 * Bounded concurrency: mappings are processed sequentially per tick to
 * avoid stampeding Frappe (10 mappings × 200 rows = 2000 requests
 * per minute would be silly). The pull cron's per-tick cost is the
 * sum of one Frappe query per active pull mapping; that's fine for
 * dozens of mappings.
 *
 * Skips silently when no mapping is configured for pull — that's the
 * default for fresh deployments.
 */
export default async function pullFromErpnext(container: MedusaContainer) {
    const erpnext: any = container.resolve(ERPNEXT_MODULE)
    let mappings: any[] = []
    try {
        mappings = await erpnext.listEnabledPullMappings()
    } catch (err: any) {
        console.warn(
            "[erpnext-pull] failed to list mappings — skipping tick:",
            err?.message,
        )
        return
    }
    if (mappings.length === 0) return

    let totalCreated = 0
    let totalUpdated = 0
    let totalErrors = 0
    for (const m of mappings) {
        try {
            const outcome = await erpnext.pullFromMapping({
                mapping: m,
                container,
            })
            totalCreated += outcome.created ?? 0
            totalUpdated += outcome.updated ?? 0
            totalErrors += outcome.errors ?? 0
            if ((outcome.pulled ?? 0) > 0 || outcome.errors) {
                console.log(
                    `[erpnext-pull] ${m.name} (${m.doctype} → ${m.medusa_entity}): ` +
                        `pulled=${outcome.pulled} created=${outcome.created} ` +
                        `updated=${outcome.updated} skipped=${outcome.skipped} ` +
                        `errors=${outcome.errors}`,
                )
            }
        } catch (err: any) {
            totalErrors += 1
            console.error(
                `[erpnext-pull] ${m.name} crashed:`,
                err?.message ?? err,
            )
        }
    }
    if (totalCreated + totalUpdated + totalErrors > 0) {
        console.log(
            `[erpnext-pull] tick done — created=${totalCreated} ` +
                `updated=${totalUpdated} errors=${totalErrors}`,
        )
    }

    await checkDrift(erpnext)
}


/**
 * While we are here and talking to ERPNext anyway: does every enabled
 * mapping still name fields that exist? A field that has been renamed or
 * removed makes a mapping fail silently, and this is the one job that
 * already has the connection open to ask.
 *
 * Deliberately after the pull and deliberately swallowed: a drift check
 * that broke the pull would be a worse problem than the drift.
 */
async function checkDrift(erpnext: any) {
    try {
        const report = await erpnext.checkMappingDrift()
        if (report?.flagged?.length) {
            console.warn(
                `[erpnext-pull] ${report.flagged.length} mapping(s) name an ERPNext field that ` +
                    `no longer exists and have been switched off: ` +
                    report.flagged.map((f: any) => f.name).join(", "),
            )
        }
    } catch (err: any) {
        console.warn("[erpnext-pull] drift check failed:", err?.message ?? err)
    }
}

export const config = {
    name: "erpnext-pull",
    // Every 5 minutes. Tight enough that an operator editing a Frappe
    // Customer sees the change reflected in Medusa within ~5 min; loose
    // enough to avoid hammering Frappe between ticks. (Was previously
    // "0 * * * *" — hourly — which contradicted this contract; restored
    // to */5 to match the documented ~5-min freshness goal and the
    // sibling erpnext-retry-events cron.)
    schedule: "*/5 * * * *",
}
