import { MedusaContainer } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"
import { ERPNEXT_MODULE } from "../modules/erpnext"
import { OUTBOUND_PAUSED } from "../modules/erpnext/outbound"
import { getMedusaEntity } from "../modules/erpnext/registry"
import { customersMissingOnFrappe } from "../modules/erpnext/customer-recovery"

/**
 * F3 — Tier-2.D reconciliation cron.
 *
 * Every hour at :30 (offset 30min from the :00 pull crons so they
 * don't race), the cron does THREE things:
 *
 *   0) SELECTION RECONCILE — every active link whose ERPNext document no
 *      longer moves ERPNext → Medusa (deselected while the webhook could
 *      not reach us, trashed, renamed) gets its product drafted; a document
 *      that became Medusa → ERPNext is left alone. The safety net under the
 *      Frappe Webhooks; see ErpnextModuleService.reconcileSelection.
 *
 *   1) DRIFT DETECTION — for every enabled mapping, compares the
 *      row count on the Frappe side (with the mapping's pull_filter)
 *      to the row count on the Medusa side. If the gap is >5%, an
 *      `erpnext_sync_event` with status='drift_detected' is written so
 *      operators see the drift on the admin Events tab.
 *
 *   2) MISSING-ON-FRAPPE RECOVERY (Customer mapping only) — finds
 *      Medusa customers with an email that Frappe has neither by email
 *      nor under their link's name, and re-pushes them via
 *      `pushViaMapping`. This is the recovery path for cases like
 *      "Frappe customer was accidentally deleted" or "Frappe came
 *      back from a restore that missed some rows" — the hourly
 *      Frappe→Medusa pull cron only sees rows Frappe currently has,
 *      so it can't detect missing-on-Frappe drift on its own.
 *
 *      Currently scoped to the Customer mapping; Sales Order /
 *      Item don't have a use case for missing-on-Frappe recovery
 *      (orders are append-only and items are seeded on demand). If
 *      other "both"-direction mappings need this in future, we'll
 *      generalize the helper.
 *
 * NB drift detection is a CHEAP cron — two count queries per mapping.
 * The missing-on-Frappe recovery makes one paged list per side
 * plus one push per gap. The comparison is
 * approximate; a drift > 5% is almost always a real bug.
 */
export default async function reconciliation(container: MedusaContainer) {
    const erpnext: any = container.resolve(ERPNEXT_MODULE)

    // ── 0a. Wallet reconcile ─────────────────────────────────────────
    try {
        const w = await erpnext.reconcileWallets(container)
        if (!w?.skipped) {
            console.log(`[erpnext-recon] wallets: checked=${w.checked} equal=${w.equal} lagging=${w.lagging} drift=${w.drift}`)
            for (const n of w.notes ?? []) console.warn("[erpnext-recon] wallet:", n)
        }
    } catch (err: any) {
        console.warn("[erpnext-recon] wallet reconcile failed:", err?.message ?? err)
    }

    // ── 0. Selection reconcile ───────────────────────────────────────
    try {
        const sel = await erpnext.reconcileSelection(container)
        if (sel?.skipped) {
            console.log(`[erpnext-recon] selection reconcile skipped: ${sel.skipped}`)
        } else {
            console.log(
                `[erpnext-recon] selection reconcile: checked=${sel.checked} drafted=${sel.drafted} ` +
                    `errors=${sel.errors?.length ?? 0}`,
            )
            for (const e of sel.errors ?? []) console.warn("[erpnext-recon] selection:", e)
        }
    } catch (err: any) {
        console.warn("[erpnext-recon] selection reconcile failed:", err?.message)
    }

    // ── 1. Drift detection ───────────────────────────────────────────
    let mappings: any[] = []
    try {
        mappings = await erpnext.listEnabledPullMappings()
    } catch {
        return
    }

    let drifts = 0
    const seenEntities = new Set<string>()
    for (const m of mappings) {
        try {
            // One detailed reconcile per reconcilable entity (customer /
            // product / order). Non-reconcilable mappings (e.g. the
            // append-only Stock Ledger Entry) return {skipped} and are
            // ignored — no presence-diff makes sense for them.
            if (seenEntities.has(m.medusa_entity)) continue
            const report = await erpnext.reconcileMapping?.(m, container)
            if (!report || report.skipped) continue
            seenEntities.add(m.medusa_entity)

            // Drift = rows that don't reconcile (missing on ERPNext, or
            // ERPNext rows orphaned from a deleted Medusa row).
            const drift =
                (report.missing_on_frappe_count ?? 0) + (report.frappe_orphans_count ?? 0)
            const total = Math.max(report.medusa_count ?? 0, report.frappe_count ?? 0, 1)
            const driftPct = drift / total
            if (drift > 0 && driftPct > 0.05) {
                drifts += 1
                console.warn(
                    `[erpnext-recon] DRIFT ${m.name}: missing_on_frappe=${report.missing_on_frappe_count} ` +
                        `orphans=${report.frappe_orphans_count} (${(driftPct * 100).toFixed(1)}%)`,
                )
                // Keep the event-row payload small — cap the embedded id
                // lists (never let a drift row balloon).
                const cappedPayload = {
                    ...report,
                    missing_on_frappe: (report.missing_on_frappe ?? []).slice(0, 25),
                    frappe_orphans: (report.frappe_orphans ?? []).slice(0, 25),
                }
                await erpnext
                    .createErpnextSyncEvents([
                        {
                            event: "reconciliation.drift",
                            event_id: `recon:${m.id}:${new Date().toISOString().slice(0, 13)}`,
                            payload: cappedPayload,
                            status: "drift_detected",
                            direction: "outbound",
                            attempts: 0,
                            last_attempt_at: new Date(),
                            last_error: `drift: missing_on_frappe=${report.missing_on_frappe_count} orphans=${report.frappe_orphans_count}`,
                            target_url: null,
                            mapping_id: m.id,
                        },
                    ])
                    .catch(() => {
                        /* dedupe on event_id (UTC hour bucket) — second
                         * run in same hour just collides and skips */
                    })
            }
        } catch (err: any) {
            console.warn(
                `[erpnext-recon] ${m.name} failed:`,
                err?.message,
            )
        }
    }
    if (drifts > 0) {
        console.log(`[erpnext-recon] tick done — ${drifts} mapping(s) in drift`)
    }

    // ── 2. Missing-on-Frappe customer recovery ───────────────────────
    try {
        const result = await recoverMissingCustomersOnFrappe(container, erpnext)
        // Always log so operators can verify the recovery pass ran
        // (skipped paths flag config issues; zero-missing is the happy
        // path and worth a single info line per tick).
        if (result.skipped) {
            console.log(
                `[erpnext-recon] customer recovery skipped: ${result.skipped}`,
            )
        } else {
            console.log(
                `[erpnext-recon] customer recovery: checked=${result.checked} ` +
                    `missing=${result.missing} re-pushed=${result.repushed} failed=${result.failed}` +
                    (result.notPushed ? ` not-pushed=${result.notPushed}` : ""),
            )
        }
    } catch (err: any) {
        console.warn(
            "[erpnext-recon] customer recovery failed:",
            err?.message,
        )
    }
    // Customers' invoice copies: fetch the ones never fetched, refresh the
    // ones ERPNext has since submitted.
    try {
        const r = await erpnext.refreshInvoicePdfs?.()
        if (r && !r.skipped) console.log(`[erpnext-recon] invoice PDFs: checked=${r.checked} refreshed=${r.refreshed} failed=${r.failed}`)
    } catch (err: any) {
        console.warn("[erpnext-recon] invoice PDF refresh failed:", err?.message)
    }
    // Stock and prices: re-read every linked Item's Bin and selling price,
    // so a delivery that never reached us is caught within the hour.
    try {
        const r = await erpnext.reconcileStockAndPrices?.(container)
        if (r && !r.skipped) {
            console.log(
                `[erpnext-recon] stock/prices: items=${r.items} stock=${r.stock} prices=${r.prices} failed=${r.failed}`,
            )
        }
    } catch (err: any) {
        console.warn("[erpnext-recon] stock/price reconcile failed:", err?.message)
    }
}

/**
 * Find Medusa customers that Frappe has lost, and re-push them via the
 * canonical Customer mapping.
 *
 * Discovery is by lowercase email comparison against the FULL Frappe
 * Customer list (no pull_filter applied) — so we don't keep re-pushing
 * mithtech-only customers that exist on Frappe but are filtered out
 * of the Medusa-side pull view. We only act on "truly missing" rows.
 *
 * Each side is read a page of 1000 at a time.
 */
async function recoverMissingCustomersOnFrappe(
    container: MedusaContainer,
    erpnext: any,
): Promise<{
    checked: number
    missing: number
    repushed: number
    failed: number
    notPushed?: number
    skipped?: string
}> {
    const limit = 1000
    const cfg = await erpnext.getActiveConfig()
    if (!cfg.enable_sync) {
        return {
            checked: 0,
            missing: 0,
            repushed: 0,
            failed: 0,
            skipped: "sync-disabled",
        }
    }
    // Re-pushing is pushing; nothing leaves while pushes are paused.
    if (OUTBOUND_PAUSED) {
        return { checked: 0, missing: 0, repushed: 0, failed: 0, skipped: "outbound-paused" }
    }
    const creds = await erpnext.getApiCredentials()
    if (!cfg.erpnext_url || !creds.api_key || !creds.api_secret) {
        return {
            checked: 0,
            missing: 0,
            repushed: 0,
            failed: 0,
            skipped: "not-configured",
        }
    }

    // 1. Find the canonical Customer push mapping. The reconciliation
    //    uses the SAME mapping the live `customer.updated` subscriber
    //    uses, so the payload transformation + receive_mapped target
    //    are identical. We look up by entity + event since the
    //    `listEnabledPushMappings` shorthand doesn't exist; the
    //    canonical event for re-pushing an existing customer is
    //    `customer.updated`.
    const customerMappings: any[] = await erpnext
        .listEnabledPushMappingsForEvent("customer", "customer.updated")
        .catch(() => [])
    const customerMapping = customerMappings.find(
        (m: any) => m.doctype === "Customer",
    )
    if (!customerMapping) {
        return {
            checked: 0,
            missing: 0,
            repushed: 0,
            failed: 0,
            skipped: "no-customer-mapping",
        }
    }

    // 2. List every Medusa customer with an email. No KYC gate: the live
    //    push dropped it, and the mapping's own trigger and the selection
    //    field decide again when each push runs.
    const customerModule: any = container.resolve(Modules.CUSTOMER)
    const allMedusa: any[] = []
    for (let skip = 0; ; skip += limit) {
        const page: any[] = await customerModule.listCustomers({}, { take: limit, skip, relations: ["addresses"] })
        allMedusa.push(...page)
        if (page.length < limit) break
    }

    // 3. List every Frappe Customer, no pull_filter: the question is
    //    whether Frappe has the row at all, not whether the pull sees it.
    const frappeEmails = new Set<string>()
    const frappeNames = new Set<string>()
    for (let start = 0; ; start += limit) {
        const fieldsJson = encodeURIComponent(JSON.stringify(["name", "email_id"]))
        const frappeUrl = `${cfg.erpnext_url}/api/resource/Customer?fields=${fieldsJson}&limit_page_length=${limit}&limit_start=${start}`
        const frappeRes = await fetch(frappeUrl, {
            method: "GET",
            headers: {
                Authorization: `token ${creds.api_key}:${creds.api_secret}`,
            },
            signal: AbortSignal.timeout(cfg.request_timeout_ms ?? 30000),
        })
        if (!frappeRes.ok) {
            return { checked: allMedusa.length, missing: 0, repushed: 0, failed: 0, skipped: `frappe-list-${frappeRes.status}` }
        }
        const frappeJson = await frappeRes.json().catch(() => ({}))
        const rows: any[] = Array.isArray(frappeJson?.data) ? frappeJson.data : []
        for (const r of rows) {
            if (r?.name) frappeNames.add(String(r.name))
            const email = String(r?.email_id ?? "").toLowerCase()
            if (email) frappeEmails.add(email)
        }
        if (rows.length < limit) break
    }

    // 4. Diff. A customer whose link still names a Frappe Customer is
    //    present even when Frappe holds no email for it.
    const links: any[] = []
    for (let skip = 0; ; skip += limit) {
        const page: any[] = await erpnext.listErpnextLinks(
            { doctype: "Customer", medusa_entity: "customer", state: "active" },
            { take: limit, skip },
        )
        links.push(...page)
        if (page.length < limit) break
    }
    const { eligible, missing } = customersMissingOnFrappe({
        customers: allMedusa,
        frappeEmails,
        frappeNames,
        links: links.map((l: any) => ({ medusa_id: String(l.medusa_id), erpnext_name: String(l.erpnext_name) })),
    })
    if (missing.length === 0) {
        return {
            checked: eligible.length,
            missing: 0,
            repushed: 0,
            failed: 0,
        }
    }

    // 5. Re-push each missing customer via the canonical mapping
    //    path. We use the SAME hydration path as the live subscriber
    //    (registry.customerEntity.fetchById), so whatever that entity
    //    declares — including fields a project's own modules add — is
    //    on the record before the mapping reads it. Without the
    //    hydration the mapping sees bare DB columns and pushes only
    //    email, phone and name.
    //
    //    Event_id prefix `reconciliation:` differentiates these from
    //    live events in the Sync Events admin view.
    const customerDescriptor = getMedusaEntity("customer")
    let repushed = 0
    let failed = 0
    let skipped = 0
    for (const c of missing) {
        try {
            const hydrated = customerDescriptor
                ? (await customerDescriptor.fetchById(container, c.id)) ?? c
                : c
            const r = await erpnext.pushViaMapping({
                mapping: customerMapping,
                event: "customer.updated",
                event_id: `reconciliation:customer:${c.id}:${Date.now()}`,
                record: hydrated,
                container,
            })
            if (r?.ok && r.status === "success") {
                repushed += 1
            } else if (r?.ok && r.status === "skipped") {
                // The mapping's trigger or the selection field said no: not a failure.
                skipped += 1
            } else {
                failed += 1
                console.warn(
                    `[erpnext-recon] re-push customer ${c.id} (${c.email}) failed:`,
                    r?.error ?? r?.reason,
                )
            }
        } catch (err: any) {
            failed += 1
            console.warn(
                `[erpnext-recon] re-push customer ${c.id} (${c.email}) threw:`,
                err?.message,
            )
        }
    }

    return {
        checked: eligible.length,
        missing: missing.length,
        repushed,
        failed,
        notPushed: skipped,
    }
}

export const config = {
    name: "erpnext-reconciliation",
    // Hourly at :30 — offset from the pull crons at :00 so they
    // don't race.
    schedule: "30 * * * *",
}
