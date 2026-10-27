import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { ERPNEXT_MODULE } from "../modules/erpnext"
import { SETTLEMENT_EVENT, settlementEventId } from "../modules/erpnext/gateway-settlements"

/**
 * A payment gateway paid out (`payment_gateway.settlement_recorded`, emitted
 * by a payment plugin such as @mithtech-medusa/cashfree). The service books
 * it in ERPNext when Settings say so, and records the outcome on the
 * settlement's sync event; a failure waits there for the retry job.
 */
export default async function erpnextSettlementHandler({ event, container }: SubscriberArgs<any>) {
    const erpnext: any = container.resolve(ERPNEXT_MODULE)
    const eventId = settlementEventId(event?.data)
    try {
        const result = await erpnext.bookSettlement(event?.data)
        if (!result.ok) console.error(`[erpnext-settlement] not booked; see sync event ${eventId}`)
    } catch (err: any) {
        console.error(`[erpnext-settlement] ${eventId} crashed: ${err?.message ?? err}`)
    }
}

export const config: SubscriberConfig = {
    event: SETTLEMENT_EVENT,
}
