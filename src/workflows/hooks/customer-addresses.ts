import { createCustomerAddressesWorkflow, updateCustomerAddressesWorkflow } from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"

/**
 * A customer's address book changing is a change to the customer: Medusa
 * emits no event of its own for it, so these hooks announce
 * `customer.updated` for the customers touched, and the customer push
 * brings ERPNext's Addresses along. A deleted address is handled by the
 * delete routes' middleware (see api/middlewares.ts): by the time the
 * delete workflow's hook runs, the address and its customer id are gone.
 * An announcement that fails is logged; it never fails the address save.
 */
async function announce(container: any, customerIds: Array<string | null | undefined>) {
    const ids = Array.from(new Set(customerIds.filter(Boolean) as string[]))
    if (!ids.length) return
    try {
        const eventBus: any = container.resolve(Modules.EVENT_BUS)
        await eventBus.emit(ids.map((id) => ({ name: "customer.updated", data: { id } })))
    } catch (err: any) {
        console.warn("[erpnext] address change not announced:", err?.message ?? err)
    }
}

createCustomerAddressesWorkflow.hooks.addressesCreated(async ({ addresses }, { container }) => {
    await announce(container, (addresses ?? []).map((a: any) => a?.customer_id))
})

updateCustomerAddressesWorkflow.hooks.addressesUpdated(async ({ addresses }, { container }) => {
    await announce(container, (addresses ?? []).map((a: any) => a?.customer_id))
})
