import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework/subscribers"
import { ERPNEXT_MODULE } from "../modules/erpnext"

/**
 * A category created or moved in Medusa, for two-way category sync. The switch
 * is read by the service, so with it off (the default) this is a settings read.
 * Never throws: a category save must not fail because ERPNext is away, and the
 * move reconciles on the next category pass.
 */
export default async function erpnextCategoryPush({ event, container }: SubscriberArgs<{ id?: string }>) {
    const id = event?.data?.id
    if (!id) return
    try {
        const erpnext: any = container.resolve(ERPNEXT_MODULE)
        const out = await erpnext.pushCategoryChange(container, event.name, id)
        if (out.ok === false) console.warn(`[erpnext-categories] push of ${id} failed: ${out.reason}`)
    } catch (err: any) {
        console.warn(`[erpnext-categories] push of ${id} failed:`, err?.message ?? err)
    }
}

export const config: SubscriberConfig = {
    event: ["product-category.created", "product-category.updated"],
}
