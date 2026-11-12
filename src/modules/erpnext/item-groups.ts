/**
 * ERPNext's Item Group tree as Medusa's product category tree.
 *
 * ERPNext owns the shape: every Item Group is one category, nested exactly as
 * ERPNext nests it, and ERPNext's root ("All Item Groups") is Medusa's top
 * level rather than a category. Every Item is filed under its group's
 * category.
 *
 * Field map, Item Group → product category:
 *
 *   name                 metadata.erpnext_item_group    the identity
 *   creation             metadata.erpnext_item_group_created
 *                                                       survives a rename, so
 *                                                       a renamed group keeps
 *                                                       its category
 *   item_group_name      name                           on create and on a
 *                                                       rename; a name edited
 *                                                       in Medusa stays
 *   parent_item_group    parent_category_id             resolved to the
 *                                                       parent's category; the
 *                                                       root becomes null
 *   is_group             metadata.erpnext_is_group
 *   image                metadata.image_url             absolute; an image set
 *                                                       in Medusa stays
 *   handle                                              derived once, never
 *                                                       changed: it is a URL
 *   exists in ERPNext    is_active                      a group gone from
 *                                                       ERPNext hides, and is
 *                                                       never deleted
 *   has published items  is_internal                    an empty group
 *                                                       ("Raw Material") stays
 *                                                       off the storefront
 *
 * Visibility is only ever undone by the sync that did it: a category somebody
 * hid by hand has no marker, so it stays hidden.
 *
 * Everything here is pure; ./item-group-sync.ts does the reading and writing.
 */

export const ITEM_GROUP_DOCTYPE = "Item Group"

export const GROUP_KEY = "erpnext_item_group"
export const GROUP_CREATED_KEY = "erpnext_item_group_created"
export const IS_GROUP_KEY = "erpnext_is_group"
/** Groups merged into a category by hand: their products are filed there. */
export const MERGED_GROUPS_KEY = "erpnext_item_groups_merged"
/** The image this sync last wrote, so an image set by hand is told apart. */
export const GROUP_IMAGE_KEY = "erpnext_item_group_image"
export const IMAGE_KEY = "image_url"
/** Set on categories the sync hid, so only those are revived automatically. */
export const SYNC_HIDDEN_KEY = "erpnext_sync_hidden"
export const SYNC_INTERNAL_KEY = "erpnext_sync_internal"
/** On a second category the sync hid because another one already mirrors the same group. */
export const DUPLICATE_OF_KEY = "erpnext_duplicate_of"
/** On a category that stays on the store with nothing to sell: its page is linked from code. */
export const KEEP_VISIBLE_KEY = "erpnext_keep_visible"
/**
 * A category carrying one of these belongs to the store alone and never
 * becomes an Item Group. `match_keywords` is a category a host fills by rule:
 * mirrored, the filing below would take its products back out.
 */
export const LOCAL_ONLY_KEYS = ["erpnext_local_only", "match_keywords"] as const

const MAX_DEPTH = 32

export type ItemGroup = {
    name: string
    item_group_name?: string | null
    parent_item_group?: string | null
    is_group?: number | boolean | null
    image?: string | null
    creation?: string | null
}

export type CategoryRow = {
    id: string
    name: string
    handle: string
    parent_category_id?: string | null
    is_active?: boolean
    is_internal?: boolean
    metadata?: Record<string, any> | null
}

export type GroupAction = "create" | "adopt" | "rename" | "reparent" | "update" | "keep" | "merged"

/** A planned write. `parentGroup` resolves to an id once parents are written. */
export type PlannedCategory = {
    group: string
    /** Null when the category sits at the top level. */
    parentGroup: string | null
    depth: number
    action: GroupAction
    /** Absent when the category has to be created. */
    id?: string
    create?: { name: string; handle: string; is_active: boolean; is_internal: boolean; metadata: Record<string, any> }
    patch?: Record<string, any>
    /** Reparent to `parentGroup`; the executor turns it into an id. */
    moveToParent?: boolean
}

export type CategoryHide = { id: string; name: string; group: string; metadata: Record<string, any> }

export type TreePlan = {
    planned: PlannedCategory[]
    hide: CategoryHide[]
    notes: string[]
}

export function groupNamesOf(metadata: Record<string, any> | null | undefined): string[] {
    const own = metadata?.[GROUP_KEY]
    const merged = metadata?.[MERGED_GROUPS_KEY]
    return [
        ...(typeof own === "string" && own ? [own] : []),
        ...(Array.isArray(merged) ? merged.filter((g): g is string => typeof g === "string" && g.length > 0) : []),
    ]
}

/**
 * The category a group's products go to, and whether it is the group's own.
 * When several categories claim one group (a race between two passes made
 * them), the pick is the same on every run: a shown one before a hidden one,
 * then the oldest id. Reading whichever the database lists first would flip
 * between runs.
 */
export function categoryForGroup<T extends { id?: string; is_active?: boolean; is_internal?: boolean; metadata?: Record<string, any> | null }>(
    categories: T[],
    group: string,
): { category: T; primary: boolean } | null {
    const owners = categories.filter((c) => c.metadata?.[GROUP_KEY] === group)
    if (owners.length) {
        const rank = (c: T) => (c.is_active === false ? 2 : 0) + (c.is_internal ? 1 : 0)
        const own = [...owners].sort((a, b) => rank(a) - rank(b) || String(a.id ?? "").localeCompare(String(b.id ?? "")))[0]
        return { category: own, primary: true }
    }
    const merged = categories.find((c) => groupNamesOf(c.metadata).includes(group))
    return merged ? { category: merged, primary: false } : null
}

export function isLocalOnly(metadata: Record<string, any> | null | undefined): boolean {
    return LOCAL_ONLY_KEYS.some((k) => metadata?.[k] !== undefined && metadata?.[k] !== null)
}

/** "Generator" and "Generators", "Oil and Lubricants" and "Oil & Lubricants". */
export function sameGroupName(a: string, b: string): boolean {
    const norm = (s: string) =>
        String(s ?? "")
            .toLowerCase()
            .replace(/&/g, " and ")
            .replace(/[^a-z0-9]+/g, " ")
            .trim()
            .replace(/s$/, "")
    return norm(a) !== "" && norm(a) === norm(b)
}

function slug(name: string): string {
    return (
        String(name ?? "")
            .toLowerCase()
            .replace(/&/g, " and ")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "category"
    )
}

/**
 * URL handle for a group name, unique against `taken`. `parentHandle` may be
 * a parent's handle or, for a parent not yet created, its group name: both
 * are slugged, so a handle never carries a space or a capital.
 */
export function uniqueHandle(name: string, taken: Set<string>, parentHandle?: string | null): string {
    const base = slug(name)
    if (!taken.has(base)) return base
    const scoped = parentHandle ? `${slug(parentHandle)}-${base}` : base
    if (!taken.has(scoped)) return scoped
    let n = 2
    while (taken.has(`${scoped}-${n}`)) n++
    return `${scoped}-${n}`
}

/** A group's image as a URL a browser can load, or null. Private files cannot. */
export function publicImageUrl(image: string | null | undefined, baseUrl: string | null | undefined): string | null {
    const raw = String(image ?? "").trim()
    if (!raw || raw.startsWith("/private/")) return null
    if (/^https?:\/\//i.test(raw)) return raw
    const base = String(baseUrl ?? "").replace(/\/+$/, "")
    return base ? `${base}${raw.startsWith("/") ? "" : "/"}${raw}` : null
}

/** ERPNext's tree root: the group with no parent. Never a category. */
function rootsOf(groups: ItemGroup[]): Set<string> {
    return new Set(groups.filter((g) => !g.parent_item_group).map((g) => g.name))
}

/** Depth below the root, parents before children; a loop in the data stops counting. */
function depthsOf(groups: ItemGroup[], roots: Set<string>): Map<string, number> {
    const parentOf = new Map(groups.map((g) => [g.name, g.parent_item_group ?? null]))
    const depths = new Map<string, number>()
    for (const g of groups) {
        let depth = 0
        let current = parentOf.get(g.name) ?? null
        while (current && !roots.has(current) && depth < MAX_DEPTH) {
            depth++
            current = parentOf.get(current) ?? null
        }
        depths.set(g.name, depth)
    }
    return depths
}

/**
 * The groups that have something to sell, counting what is filed below them,
 * so a parent with published grandchildren is visible too.
 */
export function groupsWithStock(groups: ItemGroup[], publishedByGroup: Map<string, number>): Set<string> {
    const parentOf = new Map(groups.map((g) => [g.name, g.parent_item_group ?? null]))
    const out = new Set<string>()
    for (const [name, count] of publishedByGroup) {
        if (count <= 0) continue
        let current: string | null = name
        const seen = new Set<string>()
        while (current && parentOf.has(current) && !seen.has(current)) {
            seen.add(current)
            out.add(current)
            current = parentOf.get(current) ?? null
        }
    }
    return out
}

/**
 * What one sync must do to the category tree.
 *
 * `visible` is the set of groups that may show on the storefront, or null on a
 * quick pass (a webhook) that has not counted products: existing categories
 * keep their visibility and a new one starts hidden until the full pass counts.
 */
export function planCategoryTree(args: {
    groups: ItemGroup[]
    categories: CategoryRow[]
    visible: Set<string> | null
    /** Categories that must stay on the storefront whatever the groups say. */
    keepVisible?: Set<string>
    baseUrl?: string | null
}): TreePlan {
    const { groups, categories, visible } = args
    const keepVisible = args.keepVisible ?? new Set<string>()
    const roots = rootsOf(groups)
    const depths = depthsOf(groups, roots)
    const groupNames = new Set(groups.map((g) => g.name))
    const taken = new Set(categories.map((c) => c.handle))
    const handleById = new Map(categories.map((c) => [c.id, c.handle]))
    const notes: string[] = []

    const ordered = groups
        .filter((g) => !roots.has(g.name))
        .sort((a, b) => (depths.get(a.name) ?? 0) - (depths.get(b.name) ?? 0) || a.name.localeCompare(b.name))

    // A category whose group no longer exists, keyed by the creation stamp a
    // rename keeps. Frappe's rename fires no webhook and bumps no `modified`.
    const orphanByCreation = new Map<string, CategoryRow>()
    for (const c of categories) {
        const own = c.metadata?.[GROUP_KEY]
        const created = c.metadata?.[GROUP_CREATED_KEY]
        if (typeof own === "string" && typeof created === "string" && created && !groupNames.has(own)) {
            orphanByCreation.set(created, c)
        }
    }

    const claimed = new Set<string>()
    const planned: PlannedCategory[] = []
    /** The category each planned group resolved to, for its children's lookups. */
    const idOfGroup = new Map<string, string | undefined>()

    for (const g of ordered) {
        const rawParent = g.parent_item_group ?? null
        const parentGroup = rawParent && !roots.has(rawParent) ? rawParent : null
        const depth = depths.get(g.name) ?? 0
        const parentId = parentGroup ? idOfGroup.get(parentGroup) : null
        const displayName = String(g.item_group_name || g.name).trim()
        const shouldShow = visible ? visible.has(g.name) : false

        const found = categoryForGroup(categories, g.name)
        if (found && !found.primary) {
            claimed.add(found.category.id)
            idOfGroup.set(g.name, found.category.id)
            planned.push({ group: g.name, parentGroup, depth, action: "merged", id: found.category.id })
            continue
        }

        let category: CategoryRow | undefined = found?.category
        let action: GroupAction = "keep"
        const renamedFrom = !category && g.creation ? orphanByCreation.get(String(g.creation)) : undefined
        if (renamedFrom) {
            category = renamedFrom
            action = "rename"
        }
        if (!category && (parentGroup === null || parentId !== undefined)) {
            // A category already made for this group, under the same parent,
            // is adopted rather than duplicated.
            category = categories.find(
                (c) =>
                    !claimed.has(c.id) &&
                    typeof c.metadata?.[GROUP_KEY] !== "string" &&
                    !isLocalOnly(c.metadata) &&
                    (c.parent_category_id ?? null) === (parentId ?? null) &&
                    sameGroupName(c.name, displayName),
            )
            if (category) action = "adopt"
        }

        const image = publicImageUrl(g.image, args.baseUrl)

        if (!category) {
            const parentHandle = parentId ? handleById.get(parentId) : parentGroup
            const handle = uniqueHandle(displayName, taken, parentHandle)
            taken.add(handle)
            const metadata: Record<string, any> = {
                [GROUP_KEY]: g.name,
                [IS_GROUP_KEY]: Boolean(Number(g.is_group ?? 0)),
                ...(g.creation ? { [GROUP_CREATED_KEY]: String(g.creation) } : {}),
                ...(image ? { [IMAGE_KEY]: image, [GROUP_IMAGE_KEY]: image } : {}),
                ...(shouldShow ? {} : { [SYNC_INTERNAL_KEY]: true }),
            }
            planned.push({
                group: g.name,
                parentGroup,
                depth,
                action: "create",
                create: { name: displayName, handle, is_active: true, is_internal: !shouldShow, metadata },
            })
            idOfGroup.set(g.name, undefined)
            continue
        }

        claimed.add(category.id)
        idOfGroup.set(g.name, category.id)
        const meta = { ...(category.metadata ?? {}) }
        const before = JSON.stringify(meta)
        const patch: Record<string, any> = {}

        meta[GROUP_KEY] = g.name
        meta[IS_GROUP_KEY] = Boolean(Number(g.is_group ?? 0))
        if (g.creation) meta[GROUP_CREATED_KEY] = String(g.creation)

        if (action === "rename") {
            const oldName = String(category.metadata?.[GROUP_KEY] ?? "")
            if (sameGroupName(category.name, oldName) && category.name !== displayName) patch.name = displayName
        }

        const ownImage = meta[IMAGE_KEY] ? String(meta[IMAGE_KEY]) : ""
        const lastErpImage = meta[GROUP_IMAGE_KEY] ? String(meta[GROUP_IMAGE_KEY]) : ""
        if (!ownImage || ownImage === lastErpImage) {
            if (image && image !== ownImage) {
                meta[IMAGE_KEY] = image
                meta[GROUP_IMAGE_KEY] = image
            } else if (!image && ownImage) {
                delete meta[IMAGE_KEY]
                delete meta[GROUP_IMAGE_KEY]
            }
        }

        if (category.is_active === false && meta[SYNC_HIDDEN_KEY]) {
            patch.is_active = true
            delete meta[SYNC_HIDDEN_KEY]
        }
        if (visible) {
            const show = shouldShow || keepVisible.has(category.id)
            if (show && category.is_internal && meta[SYNC_INTERNAL_KEY]) {
                patch.is_internal = false
                delete meta[SYNC_INTERNAL_KEY]
            } else if (show && (category.is_internal || category.is_active === false) && !category.metadata?.[SYNC_INTERNAL_KEY] && !category.metadata?.[SYNC_HIDDEN_KEY]) {
                notes.push(`${g.name}: has products to sell but its category "${category.name}" is hidden, not by this sync; left hidden`)
            } else if (!show && !category.is_internal) {
                patch.is_internal = true
                meta[SYNC_INTERNAL_KEY] = true
            }
        }
        if (JSON.stringify(meta) !== before) patch.metadata = meta

        const moveToParent =
            parentId === undefined ? true : (category.parent_category_id ?? null) !== (parentId ?? null)
        if (action === "keep") {
            if (moveToParent) action = "reparent"
            else if (Object.keys(patch).length) action = "update"
        }
        planned.push({
            group: g.name,
            parentGroup,
            depth,
            action,
            id: category.id,
            ...(Object.keys(patch).length ? { patch } : {}),
            ...(moveToParent ? { moveToParent } : {}),
        })
    }

    const hide: CategoryHide[] = []
    for (const c of categories) {
        const own = c.metadata?.[GROUP_KEY]
        if (typeof own !== "string" || !own || claimed.has(c.id) || roots.has(own)) continue
        if (c.is_active === false) continue
        if (groupNames.has(own)) {
            // A second category for a group that is mirrored: two pages for one group.
            const canonical = categoryForGroup(categories, own)?.category
            if (!canonical || canonical.id === c.id) continue
            hide.push({
                id: c.id,
                name: c.name,
                group: own,
                metadata: { ...(c.metadata ?? {}), [SYNC_HIDDEN_KEY]: true, [DUPLICATE_OF_KEY]: canonical.id },
            })
            notes.push(`${own}: category "${c.name}" (${c.handle}) duplicates "${canonical.name}" (${canonical.handle}); hidden`)
            continue
        }
        hide.push({ id: c.id, name: c.name, group: own, metadata: { ...(c.metadata ?? {}), [SYNC_HIDDEN_KEY]: true } })
    }

    const outside = categories.filter(
        (c) => c.is_active !== false && !c.is_internal && typeof c.metadata?.[GROUP_KEY] !== "string" && !groupNamesOf(c.metadata).length && !isLocalOnly(c.metadata),
    )
    if (outside.length) {
        notes.push(
            `${outside.length} shown categor${outside.length === 1 ? "y is" : "ies are"} not an Item Group: ${outside
                .slice(0, 5)
                .map((c) => c.handle)
                .join(", ")}${outside.length > 5 ? ", ..." : ""}`,
        )
    }

    return { planned, hide, notes }
}

/**
 * A product's category set after filing: categories that came from another
 * Item Group are dropped, everything assigned by hand or by a host's rule is
 * kept, and the target is added. Null when nothing changes.
 */
export function nextCategoryIds(current: string[], target: string, mirroredIds: Set<string>): string[] | null {
    const kept = current.filter((id) => id === target || !mirroredIds.has(id))
    const next = kept.includes(target) ? kept : [...kept, target]
    const same = next.length === current.length && next.every((id) => current.includes(id))
    return same ? null : next
}

export type FilableProduct = {
    id: string
    /** The ERPNext Item it came from; absent on a product of the store's own. */
    item_code?: string | null
    status?: string | null
    metadata?: Record<string, any> | null
    categories?: Array<{ id: string }> | null
}

export type FilingPlan = {
    /** Products whose category set changes the same way, written together. */
    batches: Array<{ categoryIds: string[]; productIds: string[] }>
    /** Products whose stored group name went stale: a rename touches no Item's `modified`. */
    staleGroups: Array<{ id: string; group: string }>
    unmapped: Map<string, number>
    /** Products whose Item ERPNext no longer lists: kept where they are, and counted apart from a group missing from the tree. */
    gone: number
}

/**
 * Where each product belongs. `itemGroups` is ERPNext's live answer per item
 * code; an item it no longer lists falls back to the group the product was
 * last pulled with.
 */
export function planProductFiling(args: {
    products: FilableProduct[]
    itemGroups: Map<string, string>
    categoryOfGroup: Map<string, string>
    mirroredIds: Set<string>
    /** The metadata key a pull stores the Item's group under. */
    groupKey: string
}): FilingPlan {
    const batches = new Map<string, { categoryIds: string[]; productIds: string[] }>()
    const staleGroups: Array<{ id: string; group: string }> = []
    const unmapped = new Map<string, number>()
    let gone = 0
    for (const p of args.products) {
        if (!p.item_code) continue
        const stored = typeof p.metadata?.[args.groupKey] === "string" ? String(p.metadata[args.groupKey]) : ""
        const live = args.itemGroups.get(p.item_code)
        const group = live ?? stored
        if (!group) continue
        if (live && live !== stored) staleGroups.push({ id: p.id, group: live })
        const target = args.categoryOfGroup.get(group)
        if (!target) {
            if (live) unmapped.set(group, (unmapped.get(group) ?? 0) + 1)
            else gone++
            continue
        }
        const next = nextCategoryIds((p.categories ?? []).map((c) => c.id), target, args.mirroredIds)
        if (!next) continue
        const key = [...next].sort().join(",")
        const batch = batches.get(key) ?? { categoryIds: next, productIds: [] }
        batch.productIds.push(p.id)
        batches.set(key, batch)
    }
    return { batches: [...batches.values()], staleGroups, unmapped, gone }
}

export type CategoryPushPlan =
    | { action: "skip"; reason: string }
    | { action: "create"; doc: Record<string, any>; parentGroup: string }
    | { action: "reparent"; group: string; parentGroup: string }

/**
 * What a category changed in Medusa means for ERPNext.
 *
 * Only a category created after two-way sync is switched on becomes a group;
 * the ones that already exist stay the store's own until someone says
 * otherwise. A name is the store's display name and does not rename the group
 * (renaming rewrites every Item under it), and nothing is ever deleted.
 */
export function planCategoryPush(args: {
    event: string
    category: CategoryRow
    parentCategory?: CategoryRow | null
    /** ERPNext's root, for a category at Medusa's top level. */
    rootGroup: string
    /** The group's parent in ERPNext, when the category is already a group. */
    remoteParent?: string | null
}): CategoryPushPlan {
    const { category, parentCategory, rootGroup } = args
    if (isLocalOnly(category.metadata)) return { action: "skip", reason: "the store's own category" }
    const own = category.metadata?.[GROUP_KEY]
    const parentGroup = parentCategory
        ? typeof parentCategory.metadata?.[GROUP_KEY] === "string"
            ? String(parentCategory.metadata[GROUP_KEY])
            : null
        : rootGroup
    if (!parentGroup) return { action: "skip", reason: "its parent is not an Item Group" }

    if (typeof own === "string" && own) {
        if (args.remoteParent === undefined || args.remoteParent === null) {
            return { action: "skip", reason: "the group's parent is unknown" }
        }
        return args.remoteParent === parentGroup
            ? { action: "skip", reason: "already nested the same way" }
            : { action: "reparent", group: own, parentGroup }
    }
    if (args.event !== "product-category.created") {
        return { action: "skip", reason: "not an Item Group; only new categories become one" }
    }
    return {
        action: "create",
        parentGroup,
        doc: {
            doctype: ITEM_GROUP_DOCTYPE,
            item_group_name: String(category.name ?? "").trim(),
            parent_item_group: parentGroup,
            is_group: 0,
        },
    }
}
