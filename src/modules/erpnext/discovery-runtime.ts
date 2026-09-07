/**
 * The impure half of field discovery: getting a module's ORM metadata out
 * of a running Medusa, so `discovery.ts` can stay a pure function.
 *
 * How the metadata is reached
 * ---------------------------
 * Every Medusa module service — core and custom alike — carries a
 * `baseRepository_` built on `MikroOrmBaseRepository`, whose `manager_` is
 * a mikro-orm `SqlEntityManager`. `getMetadata().getAll()` on that manager
 * returns the module's own entities and nothing else, keyed by class name.
 * Confirmed on Medusa 2.19 against `customer`, `order`, `product`,
 * `sales_channel` and this plugin's own `erpnext` module.
 *
 * This is deliberately reached through internals rather than a public API,
 * because Medusa exposes no public model-introspection surface. The whole
 * access path is in `ormEntitiesFor` and it fails soft: any change to
 * those internals in a future Medusa release turns discovery off and
 * leaves the curated `paths` working, rather than breaking the mapper.
 * `fields_source` in the result says which happened, so the admin UI can
 * tell an operator that discovery is unavailable instead of quietly
 * showing a short list.
 *
 * Caching
 * -------
 * Per process, keyed by entity. A model definition cannot change without a
 * redeploy, so there is nothing to invalidate at run time. Discovery is
 * per Medusa store, not global — two stores with different custom modules
 * have different field lists — and each store computing its own is exactly
 * that. The ERPNext side caches what it fetches per `Medusync Site`.
 */

import {
    describeModel,
    describeRecord,
    mergeFieldSources,
    type DiscoveredField,
    type OrmEntityMeta,
} from "./discovery"
import { getMedusaEntity, type EntityDescriptor } from "./registry"

export type FieldsSource = "model" | "record" | "curated"

export type EntityFieldsResult = {
    entity: string
    model_name: string
    /** Where the derived half came from. `curated` means discovery found
     *  nothing and only `registry.ts` contributed. */
    fields_source: FieldsSource
    fields: DiscoveredField[]
    /** Set when discovery was attempted and could not run. Surfaced in the
     *  admin UI so an operator knows the list may be short. */
    discovery_error?: string
}

const cache = new Map<string, EntityFieldsResult>()

/**
 * The module's mikro-orm entity metadata, or null if it cannot be reached.
 * Every step is optional-chained: this runs inside an admin request and a
 * missing internal must not 500 the mapper.
 */
export function ormEntitiesFor(
    container: any,
    moduleName: string,
): Record<string, OrmEntityMeta> | null {
    const service: any = container?.resolve?.(moduleName)
    const manager: any = service?.baseRepository_?.manager_
    const metadata: any = manager?.getMetadata?.()
    const all = metadata?.getAll?.()
    return all && typeof all === "object" ? all : null
}

/** One real row, used only when a model has no ORM metadata. */
async function sampleRecord(
    container: any,
    entity: EntityDescriptor,
): Promise<Record<string, any> | null> {
    const service: any = container?.resolve?.(entity.moduleName)
    const listFn = `list${entity.modelName}s`
    const rows = await service?.[listFn]?.({}, { take: 1 })
    return rows?.[0] ?? null
}

/**
 * The complete field list for one registry entity: the model's own columns
 * merged under the curated labels and transforms.
 *
 * Never throws. A deployment whose internals have moved gets the curated
 * list and an explanation, which is what the mapper had before discovery
 * existed.
 */
export async function discoverEntityFields(
    container: any,
    entityKey: string,
    opts: { refresh?: boolean } = {},
): Promise<EntityFieldsResult | null> {
    const entity = getMedusaEntity(entityKey)
    if (!entity) return null

    if (!opts.refresh) {
        const hit = cache.get(entityKey)
        if (hit) return hit
    }

    let derived: DiscoveredField[] = []
    let fields_source: FieldsSource = "curated"
    let discovery_error: string | undefined

    try {
        const entities = ormEntitiesFor(container, entity.moduleName)
        if (entities?.[entity.modelName]) {
            derived = describeModel(entities, entity.modelName)
            fields_source = "model"
        } else {
            const record = await sampleRecord(container, entity)
            if (record) {
                derived = describeRecord(record)
                fields_source = "record"
            } else {
                discovery_error = entities
                    ? `Module "${entity.moduleName}" has no model named "${entity.modelName}", and it has no rows to read instead.`
                    : `Could not read the ORM metadata of module "${entity.moduleName}".`
            }
        }
    } catch (e: any) {
        discovery_error = e?.message ?? String(e)
    }

    const result: EntityFieldsResult = {
        entity: entity.key,
        model_name: entity.modelName,
        fields_source,
        fields: mergeFieldSources(derived, entity.paths),
        ...(discovery_error ? { discovery_error } : {}),
    }

    cache.set(entityKey, result)
    return result
}

/** Drop the cache. Exists for tests and for the admin refresh button. */
export function clearDiscoveryCache(): void {
    cache.clear()
}
