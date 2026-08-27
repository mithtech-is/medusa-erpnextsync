import type {
    SubscriberArgs,
    SubscriberConfig,
} from "@medusajs/framework/subscribers"
import { ERPNEXT_MODULE } from "../modules/erpnext"
import { getMedusaEntity, listMedusaEntities } from "../modules/erpnext/registry"

/**
 * Mapping-driven Medusa → ERPNext forwarder.
 *
 * Lifecycle per event:
 *   1. Match the event name against the static event-registry to find
 *      the corresponding Medusa entity key (customer / order / product
 *      / user). Events that don't map to a registered entity are
 *      dropped silently — the operator can't have configured a mapping
 *      for them anyway.
 *   2. Pull every enabled mapping for that entity whose `events` array
 *      includes this event name (and whose direction is push or both).
 *   3. Fetch the enriched record once via the entity's registry
 *      `fetchById` adapter — shared across all mappings on the same
 *      entity so we don't re-fetch the customer/order N times.
 *   4. For each mapping: call `pushViaMapping` which runs the
 *      transform engine, POSTs the result, and logs into
 *      erpnext_sync_event tagged with mapping_id.
 *
 * Fallback to legacy behaviour:
 *   When NO mapping matches the event AND the event is one of the
 *   historically-wired set (customer.*, order.*), the legacy
 *   `forwardEvent` path runs with the enriched full payload. This
 *   keeps the existing prod behaviour working until operators
 *   migrate to explicit mappings.
 *
 * Backpressure / errors:
 *   Each `pushViaMapping` call is awaited sequentially so a slow
 *   Frappe doesn't fan out N parallel HTTP requests per event. The
 *   service swallows HTTP errors and records them on the per-event
 *   row, so order placement on the storefront is never blocked.
 */
export default async function erpnextForwardHandler({
    event,
    container,
}: SubscriberArgs<any>) {
    const eventName = event?.name as string | undefined
    if (!eventName) return

    // Bank/demat verification events carry `{id, customer_id}` —
    // we want to enrich/push the CUSTOMER, not the bank/demat row.
    // For those events the entityId is `customer_id`; for everything
    // else it's `data.id` as before.
    const isBankOrDematEvent =
        eventName.startsWith("bank_account.") ||
        eventName.startsWith("demat_account.")
    const entityId = isBankOrDematEvent
        ? ((event?.data?.customer_id as string | undefined) ??
            (event?.data?.id as string | undefined))
        : (event?.data?.id as string | undefined)
    // Idempotency key for the far side. Medusa's event envelope does not
    // reliably carry a top-level `id` (workflow-emitted events often omit
    // it), so fall back to a synthesised, per-emission id rather than
    // dropping the event — otherwise create/delete events silently never
    // sync. A real `id`, when present, still wins so genuine retries dedupe.
    const eventId =
        ((event as any)?.id as string | undefined) ??
        ((event as any)?.metadata?.eventId as string | undefined) ??
        ((event as any)?.metadata?.id as string | undefined) ??
        (entityId
            ? `medusa:${eventName}:${entityId}:${Date.now()}`
            : undefined)
    if (!eventId) {
        console.warn(
            `[erpnext-forward] skipping ${eventName}: no event id and no entity id`,
        )
        return
    }

    const entityKey = resolveEntityKey(eventName)
    const erpnext: any = container.resolve(ERPNEXT_MODULE)

    let enriched: any = event?.data ?? {}
    let mappings: any[] = []
    if (entityKey) {
        const descriptor = getMedusaEntity(entityKey)
        if (descriptor && entityId) {
            try {
                enriched = (await descriptor.fetchById(container, entityId)) ?? enriched
            } catch (err) {
                console.warn(
                    `[erpnext-forward] enrichment failed for ${eventName}:`,
                    err,
                )
            }
        }
        try {
            mappings = await erpnext.listEnabledPushMappingsForEvent(
                entityKey,
                eventName,
            )
        } catch (err) {
            console.warn(
                `[erpnext-forward] mapping lookup failed for ${eventName}:`,
                err,
            )
        }
    }

    // NB there is no KYC gate here any more.
    //
    // This used to hard-code "skip customer.* unless
    // metadata.kyc_fully_approved_at is set" for every customer mapping,
    // whether or not the operator wanted it, with no way to see or
    // change it from the admin. That rule now lives on the mapping row
    // as a trigger condition (see modules/erpnext/trigger.ts) and is
    // enforced inside pushViaMapping, so it applies to the bulk-push
    // routes and scripted pushes too — not just to live events.
    //
    // The migration moves every existing customer mapping onto the
    // "KYC fully verified" preset, so behaviour is unchanged until an
    // operator deliberately picks something else.
    //
    // The legacy fallback below is NOT trigger-gated, because it runs
    // only when no mapping matched at all — there is no mapping to read
    // a condition from. It keeps its own KYC check.

    if (mappings.length > 0) {
        for (const m of mappings) {
            const result = await erpnext.pushViaMapping({
                mapping: m,
                event: eventName,
                event_id: `${eventId}:${m.id}`,
                record: enriched,
            })
            if (!result.ok) {
                console.error(
                    `[erpnext-forward] ${eventName} via mapping ${m.name} (${m.id}) → ${result.error}`,
                )
            }
        }
        return
    }

    // No mapping matched this event → nothing to sync. The connector is
    // mapping-driven: an operator enables a doctype by creating a mapping
    // row for it. (The old Polemarch-era "legacy full-payload forward" for
    // unmapped customer.*/order.* events was removed — it pushed to the
    // domain-specific `receive` handler pack and produced noisy failures for
    // events like `customer.synced` that were never meant to sync.)
    return
}

/**
 * Map an event name to the Medusa entity key it concerns. Drives the
 * mapping-lookup query — without this we'd have to ask the database
 * "give me every mapping with this event in its array", which is fine
 * but more expensive than scoping by entity first.
 *
 * Built from the registry so adding a new entity automatically wires
 * up its events as well — no double bookkeeping. Doesn't filter by
 * availability here; the mapping lookup is cheap and any mapping that
 * references an unavailable entity simply finds nothing.
 */
function resolveEntityKey(eventName: string): string | null {
    for (const e of listMedusaEntities()) {
        if (e.events.includes(eventName)) return e.key
    }
    // Also accept any custom event prefix the operator put on the
    // mapping (e.g. `app.kyc.verified`). Fall through and let
    // the mapping lookup figure it out — those don't need
    // pre-enrichment.
    const dotIdx = eventName.indexOf(".")
    if (dotIdx > 0) return eventName.slice(0, dotIdx)
    return null
}

/**
 * Subscribe to every Medusa event a registered entity declares. The
 * resulting array is computed at import time so the framework's
 * subscriber loader sees a static config. Adding an entity to the
 * registry instantly extends this list — no extra wiring.
 */
function buildSubscribedEvents(): string[] {
    const set = new Set<string>()
    for (const e of listMedusaEntities()) {
        for (const ev of e.events) set.add(ev)
    }
    return Array.from(set)
}

export const config: SubscriberConfig = {
    event: buildSubscribedEvents(),
}
