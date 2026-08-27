import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { listMedusaEntities } from "../../../../modules/erpnext/registry"

/**
 * GET /admin/erpnext/medusa-entities
 *
 * Return the registry of Medusa entities the mapping UI can target,
 * filtered by which underlying modules are actually installed on
 * this deployment. Custom modules (cashfree_wallet, calcula,
 * watchlist, share_transfer, etc.) only appear when their module is
 * registered in medusa-config.ts — Medusa builds without one stay
 * out of the picker so operators don't configure mappings against
 * a missing source.
 *
 * Built-in Medusa modules (Customer, Order, Product, Cart, Region,
 * SalesChannel, Promotion, …) are always available.
 *
 * Adding a new entity is a code change (registry.ts), not a runtime
 * configuration — fields are intentionally curated rather than
 * introspected off the Medusa schema (schemas drift across
 * Medusa versions; curated dot-paths match what the store actually
 * surfaces on each entity).
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
    const items = listMedusaEntities(req.scope).map((e) => ({
        key: e.key,
        label: e.label,
        module_name: e.moduleName,
        is_custom_module: e.isCustomModule,
        events: e.events,
        default_key_path: e.default_key_path,
        paths: e.paths,
    }))
    res.json({ items })
}
