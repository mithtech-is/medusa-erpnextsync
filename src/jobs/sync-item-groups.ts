import { MedusaContainer } from "@medusajs/framework/types"
import { ERPNEXT_MODULE } from "../modules/erpnext"

/**
 * The full category pass: the Item Group tree, which group has something to
 * sell, and where each product is filed. Webhooks keep it current between runs;
 * this is what catches a rename, which fires no webhook and touches no Item's
 * `modified`.
 */
export default async function syncItemGroups(container: MedusaContainer) {
    const erpnext: any = container.resolve(ERPNEXT_MODULE)
    try {
        const out = await erpnext.syncCategories(container)
        if ("skipped" in out) return
        if (out.notes.length) console.warn(`[erpnext-categories] ${out.notes.join("; ")}`)
        const changed = out.created + out.adopted + out.renamed + out.reparented + out.updated + out.hidden + out.products_filed + out.products_regrouped
        if (changed) console.log(`[erpnext-categories] ${JSON.stringify({ ...out, plan: undefined })}`)
    } catch (err: any) {
        console.error("[erpnext-categories] failed:", err?.message ?? err)
    }
}

export const config = {
    name: "erpnext-sync-item-groups",
    schedule: "1-59/10 * * * *",
}
