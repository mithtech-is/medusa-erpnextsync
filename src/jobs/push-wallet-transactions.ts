import { MedusaContainer } from "@medusajs/framework/types"
import { ERPNEXT_MODULE } from "../modules/erpnext"
import { OUTBOUND_PAUSED } from "../modules/erpnext/outbound"

/**
 * Every five minutes: every main-bucket wallet row ERPNext does not hold
 * yet, oldest first. The safety net under the wallet subscriber — an
 * order debit made by the credit provider fires no wallet event, and a
 * push that failed while ERPNext was down is retried here.
 */
export default async function pushWalletTransactions(container: MedusaContainer) {
    if (OUTBOUND_PAUSED) return
    const erpnext: any = container.resolve(ERPNEXT_MODULE)
    try {
        const out = await erpnext.sweepWalletTransactions(container, { limit: 200 })
        if (out?.skipped) return
        if (out.pushed || out.failed) {
            console.log(`[erpnext-wallet] sweep: scanned=${out.scanned} pushed=${out.pushed} failed=${out.failed}`)
            for (const n of out.notes ?? []) console.warn("[erpnext-wallet]", n)
        }
    } catch (err: any) {
        console.warn("[erpnext-wallet] sweep failed:", err?.message ?? err)
    }
}

export const config = {
    name: "erpnext-push-wallet-transactions",
    // Offset from the pull at :00/:05… so the two do not race for the API.
    schedule: "2-59/5 * * * *",
}
