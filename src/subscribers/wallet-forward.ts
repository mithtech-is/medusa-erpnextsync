import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { ERPNEXT_MODULE } from "../modules/erpnext"
import { OUTBOUND_PAUSED } from "../modules/erpnext/outbound"

/**
 * Wallet rows → ERPNext, right after a movement.
 *
 * The wallet plugin announces deposits, top-ups, held-order captures and
 * payouts on the event bus; an order paid from the wallet is announced
 * as the order. Each carries the customer, so the sweep runs for that
 * customer alone and pushes every main-bucket row of theirs that ERPNext
 * does not hold yet, oldest first. The five-minute job catches anything
 * announced on no event.
 */
export default async function walletForward({ event, container }: SubscriberArgs<any>) {
    if (OUTBOUND_PAUSED) return
    const erpnext: any = container.resolve(ERPNEXT_MODULE)
    let customer_id: string | null = event?.data?.customer_id ? String(event.data.customer_id) : null
    if (!customer_id && String(event?.name ?? "").startsWith("order.") && event?.data?.id) {
        try {
            const query: any = container.resolve("query")
            const { data } = await query.graph({ entity: "order", fields: ["id", "customer_id"], filters: { id: String(event.data.id) } })
            customer_id = data?.[0]?.customer_id ? String(data[0].customer_id) : null
        } catch {
            customer_id = null
        }
    }
    if (!customer_id) return
    try {
        const out = await erpnext.sweepWalletTransactions(container, { customer_id, limit: 50 })
        if (out?.failed) console.warn(`[erpnext-wallet] ${event.name}: ${out.failed} row(s) not pushed —`, out.notes)
    } catch (err: any) {
        console.warn(`[erpnext-wallet] ${event.name}: sweep failed:`, err?.message ?? err)
    }
}

export const config: SubscriberConfig = {
    event: [
        "wallet.deposit.credited",
        "wallet.topup.credited",
        "wallet.held_order.captured",
        "wallet.withdrawal.requested",
        "wallet.withdrawal.decided",
        "wallet.withdrawal.paid",
        "wallet.withdrawal.failed",
        "order.placed",
        "order.canceled",
        "payment.captured",
    ],
}
