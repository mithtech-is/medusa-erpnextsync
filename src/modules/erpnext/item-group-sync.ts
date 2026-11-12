import type { FrappeClient } from "./frappe-client"
import {
    DUPLICATE_OF_KEY,
    ITEM_GROUP_DOCTYPE,
    KEEP_VISIBLE_KEY,
    categoryForGroup,
    groupNamesOf,
    groupsWithStock,
    nextCategoryIds,
    planCategoryTree,
    planProductFiling,
    type CategoryRow,
    type FilableProduct,
    type GroupAction,
    type ItemGroup,
} from "./item-groups"

/**
 * The reading and writing behind ./item-groups.ts.
 *
 * A full pass reads the whole tree, every Item's group and every product. A
 * quick pass (a webhook, or a product filed under a group not seen yet) only
 * brings the tree up to date and leaves counting to the next full pass.
 */

const ITEM_PAGE = 5000
const PRODUCT_PAGE = 1000
const UPDATE_BATCH = 200
const CATEGORY_SELECT = ["id", "name", "handle", "parent_category_id", "is_active", "is_internal", "metadata"]
const GROUP_FIELDS = ["name", "item_group_name", "parent_item_group", "is_group", "image", "creation"]

export const CATEGORIES_SYNCED_EVENT = "erpnext.categories.synced"

export type CategorySyncReport = {
    at: string
    dry_run: boolean
    mode: "full" | "quick"
    groups: number
    created: number
    adopted: number
    renamed: number
    reparented: number
    updated: number
    hidden: number
    products_filed: number
    products_regrouped: number
    /** What each group resolved to, parents first. */
    plan: Array<{ group: string; parent: string | null; action: GroupAction; category?: string }>
    notes: string[]
}

export type CategorySyncDeps = {
    client: FrappeClient
    productModule: any
    query: any
    baseUrl: string | null
    /** The metadata key a pull stores the Item's group under. */
    groupKey: string
    /** The metadata key that names a product's Item. */
    itemCodeKey: string
    /** Medusa's Postgres connection (knex). With it, only one process at a time writes the tree. */
    pg?: any
}

/** Another pass holds the tree: this process's, or (through Postgres) another process's. */
export class CategorySyncBusy extends Error {
    constructor() {
        super("a category sync is already running")
    }
}

const LOCK_KEY = "erpnext:category-sync"
let _running = false

/**
 * One writer for the category tree. The webhook handler (server process), the
 * scheduled pass (worker process) and the product pull's quick pass all create
 * categories, and each reads the tree before it writes: two at once make two
 * categories, and so two pages, for one group. A flag only covers one process,
 * so Postgres' advisory lock covers the rest.
 */
export async function withCategoryLock<T>(deps: Pick<CategorySyncDeps, "pg">, fn: () => Promise<T>): Promise<T> {
    if (_running) throw new CategorySyncBusy()
    _running = true
    try {
        if (!deps.pg?.transaction) return await fn()
        return await deps.pg.transaction(async (trx: any) => {
            const res = await trx.raw("select pg_try_advisory_xact_lock(hashtext(?)) as ok", [LOCK_KEY])
            const row = Array.isArray(res?.rows) ? res.rows[0] : Array.isArray(res) ? res[0] : res
            if (!row?.ok) throw new CategorySyncBusy()
            return await fn()
        })
    } finally {
        _running = false
    }
}

function resourcePath(doctype: string): string {
    return `/api/resource/${encodeURIComponent(doctype)}`
}

export async function fetchItemGroups(client: FrappeClient): Promise<ItemGroup[]> {
    const res = await client.get(resourcePath(ITEM_GROUP_DOCTYPE), {
        fields: JSON.stringify(GROUP_FIELDS),
        limit_page_length: "0",
    })
    if (res.ok === false) throw new Error(`Item Group list failed: ${res.error}`)
    return (Array.isArray(res.data) ? res.data : []) as ItemGroup[]
}

async function fetchItemGroupsByItem(client: FrappeClient): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (let start = 0; ; start += ITEM_PAGE) {
        const res = await client.get(resourcePath("Item"), {
            fields: JSON.stringify(["name", "item_group"]),
            limit_start: String(start),
            limit_page_length: String(ITEM_PAGE),
            order_by: "name asc",
        })
        if (res.ok === false) throw new Error(`Item list failed: ${res.error}`)
        const rows: any[] = Array.isArray(res.data) ? res.data : []
        for (const r of rows) {
            if (r?.name && r?.item_group) out.set(String(r.name), String(r.item_group))
        }
        if (rows.length < ITEM_PAGE) return out
    }
}

function listCategories(productModule: any): Promise<CategoryRow[]> {
    return productModule.listProductCategories({}, { select: CATEGORY_SELECT, take: 100_000 })
}

async function listProducts(query: any, itemCodeKey: string): Promise<FilableProduct[]> {
    const rows: FilableProduct[] = []
    for (let skip = 0; ; skip += PRODUCT_PAGE) {
        const { data } = await query.graph({
            entity: "product",
            fields: ["id", "status", "metadata", "categories.id"],
            pagination: { skip, take: PRODUCT_PAGE, order: { id: "ASC" } },
        })
        const page: any[] = data ?? []
        for (const p of page) {
            const code = p.metadata?.[itemCodeKey]
            rows.push({ ...p, item_code: typeof code === "string" && code ? code : null })
        }
        if (page.length < PRODUCT_PAGE) return rows
    }
}

/**
 * Categories the groups alone would hide but the storefront still needs: one
 * holding a product of the store's own, one the store marked to stay, and the
 * parent of a category the store made by hand.
 */
function categoriesToKeepVisible(categories: CategoryRow[], products: FilableProduct[]): Set<string> {
    const keep = new Set<string>()
    for (const p of products) {
        if (p.item_code || p.status !== "published") continue
        for (const c of p.categories ?? []) keep.add(c.id)
    }
    for (const c of categories) {
        if (c.metadata?.[KEEP_VISIBLE_KEY]) keep.add(c.id)
        if (c.parent_category_id && c.is_active !== false && !c.is_internal && !groupNamesOf(c.metadata).length) {
            keep.add(c.parent_category_id)
        }
    }
    return keep
}

function emptyReport(mode: "full" | "quick", dryRun: boolean): CategorySyncReport {
    return {
        at: new Date().toISOString(),
        dry_run: dryRun,
        mode,
        groups: 0,
        created: 0,
        adopted: 0,
        renamed: 0,
        reparented: 0,
        updated: 0,
        hidden: 0,
        products_filed: 0,
        products_regrouped: 0,
        plan: [],
        notes: [],
    }
}

export function reportChanged(r: CategorySyncReport): boolean {
    return r.created + r.adopted + r.renamed + r.reparented + r.updated + r.hidden + r.products_filed + r.products_regrouped > 0
}

export async function runCategorySync(
    deps: CategorySyncDeps,
    options: { dryRun?: boolean; mode?: "full" | "quick"; groups?: ItemGroup[] } = {},
): Promise<CategorySyncReport> {
    if (options.dryRun) return runCategorySyncLocked(deps, options)
    return withCategoryLock(deps, () => runCategorySyncLocked(deps, options))
}

async function runCategorySyncLocked(
    deps: CategorySyncDeps,
    options: { dryRun?: boolean; mode?: "full" | "quick"; groups?: ItemGroup[] },
): Promise<CategorySyncReport> {
    const dryRun = Boolean(options.dryRun)
    const mode = options.mode ?? "full"
    const report = emptyReport(mode, dryRun)
    const { productModule, query } = deps

    const groups = options.groups ?? (await fetchItemGroups(deps.client))
    if (!groups.length) {
        report.notes.push("ERPNext returned no Item Groups; nothing changed")
        return report
    }
    const categories = await listCategories(productModule)

    let products: FilableProduct[] = []
    let itemGroups = new Map<string, string>()
    let visible: Set<string> | null = null
    let keepVisible = new Set<string>()
    if (mode === "full") {
        ;[products, itemGroups] = await Promise.all([listProducts(query, deps.itemCodeKey), fetchItemGroupsByItem(deps.client)])
        const published = new Map<string, number>()
        for (const p of products) {
            if (!p.item_code || p.status !== "published") continue
            const stored = p.metadata?.[deps.groupKey]
            const group = itemGroups.get(p.item_code) ?? (typeof stored === "string" ? stored : "")
            if (group) published.set(group, (published.get(group) ?? 0) + 1)
        }
        visible = groupsWithStock(groups, published)
        keepVisible = categoriesToKeepVisible(categories, products)
    }

    const plan = planCategoryTree({ groups, categories, visible, keepVisible, baseUrl: deps.baseUrl })
    report.groups = plan.planned.length
    report.notes.push(...plan.notes)

    const idOfGroup = new Map<string, string>()
    const nameOfCategory = new Map(categories.map((c) => [c.id, c.name]))
    for (const item of plan.planned) {
        const parentId = item.parentGroup ? idOfGroup.get(item.parentGroup) : null
        if (item.parentGroup && !parentId && !dryRun) {
            report.notes.push(`${item.group}: its parent ${item.parentGroup} could not be resolved; left as it is`)
            continue
        }
        let id = item.id
        if (item.create) {
            if (dryRun) {
                id = `dry_${item.create.handle}`
            } else {
                const created = await productModule.createProductCategories({ ...item.create, parent_category_id: parentId ?? null })
                id = (Array.isArray(created) ? created[0] : created).id as string
            }
            report.created++
        } else if (id) {
            const patch: Record<string, any> = { ...(item.patch ?? {}) }
            if (item.moveToParent) patch.parent_category_id = parentId ?? null
            if (Object.keys(patch).length) {
                if (!dryRun) await productModule.updateProductCategories(id, patch)
                if (item.moveToParent) report.reparented++
                if (item.action === "adopt") report.adopted++
                else if (item.action === "rename") report.renamed++
                else if (!item.moveToParent) report.updated++
            }
        }
        if (id) idOfGroup.set(item.group, id)
        report.plan.push({
            group: item.group,
            parent: item.parentGroup,
            action: item.action,
            category: item.create?.name ?? (id ? nameOfCategory.get(id) : undefined),
        })
    }

    for (const gone of plan.hide) {
        if (!dryRun) await productModule.updateProductCategories(gone.id, { is_active: false, metadata: gone.metadata })
        report.hidden++
        if (!gone.metadata[DUPLICATE_OF_KEY]) report.notes.push(`${gone.group}: no longer in ERPNext; category "${gone.name}" hidden`)
    }

    if (mode === "full") {
        const mirroredIds = new Set(categories.filter((c) => groupNamesOf(c.metadata).length).map((c) => c.id))
        for (const id of idOfGroup.values()) mirroredIds.add(id)
        const filing = planProductFiling({
            products,
            itemGroups,
            categoryOfGroup: idOfGroup,
            mirroredIds,
            groupKey: deps.groupKey,
        })
        for (const [group, count] of filing.unmapped) {
            report.notes.push(`${count} product(s) name group "${group}", which is not in ERPNext's tree`)
        }
        if (filing.gone) report.notes.push(`${filing.gone} product(s) whose Item is no longer in ERPNext; left as they are`)
        for (const { categoryIds, productIds } of filing.batches) {
            for (let i = 0; i < productIds.length; i += UPDATE_BATCH) {
                const ids = productIds.slice(i, i + UPDATE_BATCH)
                if (!dryRun) await productModule.updateProducts({ id: ids }, { category_ids: categoryIds })
                report.products_filed += ids.length
            }
        }
        const byId = new Map(products.map((p) => [p.id, p]))
        for (const { id, group } of filing.staleGroups) {
            if (!dryRun) {
                await productModule.updateProducts(id, { metadata: { ...(byId.get(id)?.metadata ?? {}), [deps.groupKey]: group } })
            }
            report.products_regrouped++
        }
    }
    return report
}

/**
 * Put freshly pulled products under their groups' categories, adding the group
 * first when the Item arrived before the group's own webhook. Failures are for
 * the caller to note: the product is already written, and the next full pass
 * files it anyway.
 */
export async function fileProductsUnderGroups(
    deps: CategorySyncDeps,
    rows: Array<{ productId: string; group: string }>,
): Promise<{ filed: number; missing: string[] }> {
    const wanted = rows.filter((r) => r.productId && r.group)
    if (!wanted.length) return { filed: 0, missing: [] }
    const { productModule } = deps
    let categories = await listCategories(productModule)
    const unknown = wanted.some((r) => !categoryForGroup(categories, r.group))
    if (unknown) {
        try {
            await runCategorySync(deps, { mode: "quick" })
        } catch (err) {
            // Another pass is writing the tree; it files this product on its own run.
            if (!(err instanceof CategorySyncBusy)) throw err
        }
        categories = await listCategories(productModule)
    }
    const mirroredIds = new Set(categories.filter((c) => groupNamesOf(c.metadata).length).map((c) => c.id))
    const products: any[] = await productModule.listProducts(
        { id: wanted.map((r) => r.productId) },
        { select: ["id"], relations: ["categories"], take: wanted.length },
    )
    const current = new Map(products.map((p) => [p.id, (p.categories ?? []).map((c: any) => c.id as string)]))
    const missing = new Set<string>()
    let filed = 0
    for (const { productId, group } of wanted) {
        const found = categoryForGroup(categories, group)
        if (!found) {
            missing.add(group)
            continue
        }
        const next = nextCategoryIds(current.get(productId) ?? [], found.category.id, mirroredIds)
        if (!next) continue
        await productModule.updateProducts(productId, { category_ids: next })
        filed++
    }
    return { filed, missing: [...missing] }
}
