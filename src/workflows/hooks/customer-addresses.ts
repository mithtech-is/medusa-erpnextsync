import {
    createCustomerAddressesWorkflow,
    deleteCustomerAddressesWorkflow,
    updateCustomerAddressesWorkflow,
} from "@medusajs/medusa/core-flows"
import { Modules } from "@medusajs/framework/utils"

/**
 * A customer's address book changing is a change to the customer: Medusa
 * emits no event of its own for it, so each address workflow announces
 * `customer.updated` for the customers it touched, and the customer push
 * brings ERPNext's Addresses along.
 */
async function announce(container: any, customerIds: Array<string | null | undefined>) {
    const ids = Array.from(new Set(customerIds.filter(Boolean) as string[]))
    if (!ids.length) return
    const eventBus: any = container.resolve(Modules.EVENT_BUS)
    await eventBus.emit(ids.map((id) => ({ name: "customer.updated", data: { id } })))
}

createCustomerAddressesWorkflow.hooks.addressesCreated(async ({ addresses }, { container }) => {
    await announce(container, (addresses ?? []).map((a: any) => a?.customer_id))
})

updateCustomerAddressesWorkflow.hooks.addressesUpdated(async ({ addresses }, { container }) => {
    await announce(container, (addresses ?? []).map((a: any) => a?.customer_id))
})

deleteCustomerAddressesWorkflow.hooks.addressesDeleted(async ({ ids }, { container }) => {
    const customer: any = container.resolve(Modules.CUSTOMER)
    const rows: any[] = await customer.listCustomerAddresses({ id: ids ?? [] }, { withDeleted: true, select: ["id", "customer_id"] })
    await announce(container, rows.map((a) => a?.customer_id))
})
