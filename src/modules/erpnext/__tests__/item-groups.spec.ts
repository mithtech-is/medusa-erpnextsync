import { describe, expect, it } from "vitest"
import {
    GROUP_CREATED_KEY,
    GROUP_IMAGE_KEY,
    DUPLICATE_OF_KEY,
    GROUP_KEY,
    IMAGE_KEY,
    IS_GROUP_KEY,
    MERGED_GROUPS_KEY,
    SYNC_HIDDEN_KEY,
    SYNC_INTERNAL_KEY,
    groupsWithStock,
    nextCategoryIds,
    planCategoryPush,
    planCategoryTree,
    planProductFiling,
    publicImageUrl,
    sameGroupName,
    uniqueHandle,
    type CategoryRow,
    type ItemGroup,
} from "../item-groups"

const ROOT = "All Item Groups"
const group = (name: string, parent: string | null = ROOT, extra: Partial<ItemGroup> = {}): ItemGroup => ({
    name,
    item_group_name: name,
    parent_item_group: parent,
    is_group: 0,
    creation: `created-${name}`,
    ...extra,
})
const cat = (id: string, name: string, extra: Partial<CategoryRow> = {}): CategoryRow => ({
    id,
    name,
    handle: id,
    parent_category_id: null,
    is_active: true,
    is_internal: false,
    metadata: {},
    ...extra,
})
const mirrored = (id: string, name: string, extra: Partial<CategoryRow> = {}) =>
    cat(id, name, { ...extra, metadata: { [GROUP_KEY]: name, [GROUP_CREATED_KEY]: `created-${name}`, [IS_GROUP_KEY]: false, ...(extra.metadata ?? {}) } })
const planOf = (r: ReturnType<typeof planCategoryTree>, name: string) => r.planned.find((p) => p.group === name)!

describe("the category tree follows the Item Group tree", () => {
    it("never makes a category of ERPNext's root, and keeps every level of nesting", () => {
        const groups = [
            group(ROOT, null),
            group("Products", ROOT, { is_group: 1 }),
            group("Electronics", "Products", { is_group: 1 }),
            group("Laptops", "Electronics", { is_group: 1 }),
            group("Gaming Laptops", "Laptops"),
        ]
        const r = planCategoryTree({ groups, categories: [], visible: new Set(["Products", "Electronics", "Laptops", "Gaming Laptops"]) })
        expect(r.planned.map((p) => [p.group, p.parentGroup, p.depth])).toEqual([
            ["Products", null, 0],
            ["Electronics", "Products", 1],
            ["Laptops", "Electronics", 2],
            ["Gaming Laptops", "Laptops", 3],
        ])
        expect(r.planned.every((p) => p.action === "create")).toBe(true)
        expect(planOf(r, "Laptops").create!.metadata[IS_GROUP_KEY]).toBe(true)
    })

    it("moves a top-level group out from under a category it was forced into", () => {
        const groups = [group(ROOT, null), group("Generator", ROOT, { is_group: 1 }), group("Spare Parts"), group("Filter", "Generator")]
        const categories = [
            cat("gen", "Generators"),
            mirrored("spares", "Spare Parts", { parent_category_id: "gen" }),
            mirrored("filter", "Filter", { parent_category_id: "gen" }),
        ]
        const r = planCategoryTree({ groups, categories, visible: new Set(["Generator", "Spare Parts", "Filter"]) })
        expect(planOf(r, "Generator")).toMatchObject({ action: "adopt", id: "gen", parentGroup: null })
        expect(planOf(r, "Generator").moveToParent).toBeUndefined()
        expect(planOf(r, "Spare Parts")).toMatchObject({ action: "reparent", id: "spares", parentGroup: null, moveToParent: true })
        expect(planOf(r, "Filter")).toMatchObject({ id: "filter", parentGroup: "Generator" })
        expect(planOf(r, "Filter").moveToParent).toBeUndefined()
    })

    it("does nothing on a second run", () => {
        const groups = [group(ROOT, null), group("Generator", ROOT, { is_group: 1 }), group("Filter", "Generator")]
        const categories = [
            mirrored("gen", "Generators", { metadata: { [GROUP_KEY]: "Generator", [GROUP_CREATED_KEY]: "created-Generator", [IS_GROUP_KEY]: true } }),
            mirrored("filter", "Filter", { parent_category_id: "gen" }),
        ]
        const r = planCategoryTree({ groups, categories, visible: new Set(["Generator", "Filter"]) })
        expect(r.planned.map((p) => p.action)).toEqual(["keep", "keep"])
        expect(r.planned.every((p) => !p.patch && !p.moveToParent)).toBe(true)
        expect(r.hide).toEqual([])
    })

    it("nests a child under its parent's category when the parent is only now being created", () => {
        const groups = [group(ROOT, null), group("New"), group("Child", "New")]
        const r = planCategoryTree({ groups, categories: [mirrored("child", "Child")], visible: new Set() })
        expect(planOf(r, "New").action).toBe("create")
        expect(planOf(r, "Child")).toMatchObject({ id: "child", parentGroup: "New", moveToParent: true })
    })
})

describe("a renamed group", () => {
    const groups = [group(ROOT, null), group("Spares", ROOT, { creation: "created-Spare Parts" })]

    it("keeps its category, found by the creation stamp a rename leaves alone", () => {
        const r = planCategoryTree({ groups, categories: [mirrored("spares", "Spare Parts")], visible: new Set(["Spares"]) })
        expect(planOf(r, "Spares")).toMatchObject({ action: "rename", id: "spares" })
        expect(planOf(r, "Spares").patch).toMatchObject({ name: "Spares", metadata: { [GROUP_KEY]: "Spares" } })
        expect(r.hide).toEqual([])
    })

    it("leaves a name edited in the store alone", () => {
        const r = planCategoryTree({
            groups,
            categories: [cat("spares", "Genset parts", { metadata: { [GROUP_KEY]: "Spare Parts", [GROUP_CREATED_KEY]: "created-Spare Parts" } })],
            visible: new Set(["Spares"]),
        })
        expect(planOf(r, "Spares").patch!.name).toBeUndefined()
        expect(planOf(r, "Spares").patch!.metadata[GROUP_KEY]).toBe("Spares")
    })
})

describe("what the sync leaves alone", () => {
    it("hides a category whose group is gone, and deletes nothing", () => {
        const r = planCategoryTree({ groups: [group(ROOT, null)], categories: [mirrored("old", "Old")], visible: new Set() })
        expect(r.hide).toEqual([expect.objectContaining({ id: "old", metadata: expect.objectContaining({ [SYNC_HIDDEN_KEY]: true }) })])
    })

    it("revives only what it hid itself", () => {
        const groups = [group(ROOT, null), group("A"), group("B")]
        const r = planCategoryTree({
            groups,
            categories: [
                mirrored("a", "A", { is_active: false, metadata: { [SYNC_HIDDEN_KEY]: true } }),
                mirrored("b", "B", { is_active: false }),
            ],
            visible: new Set(["A", "B"]),
        })
        expect(planOf(r, "A").patch!.is_active).toBe(true)
        expect(planOf(r, "B").patch?.is_active).toBeUndefined()
    })

    it("does not touch categories that came from no group, or adopt one filled by rule", () => {
        const groups = [group(ROOT, null), group("Tools")]
        const r = planCategoryTree({
            groups,
            categories: [cat("kw", "Tools", { metadata: { match_keywords: ["drill"] } }), cat("seed", "Welding")],
            visible: new Set(),
        })
        expect(planOf(r, "Tools").action).toBe("create")
        expect(r.hide).toEqual([])
    })

    it("files a group merged into another category there, without moving that category", () => {
        const groups = [group(ROOT, null), group("Filter"), group("Spare Parts")]
        const categories = [mirrored("spares", "Spare Parts", { metadata: { [MERGED_GROUPS_KEY]: ["Filter"] } })]
        const r = planCategoryTree({ groups, categories, visible: new Set(["Spare Parts"]) })
        expect(planOf(r, "Filter")).toMatchObject({ action: "merged", id: "spares" })
        expect(planOf(r, "Filter").patch).toBeUndefined()
    })

    it("keeps an image set in the store, and follows one it set itself", () => {
        const url = "https://erp.example.com/files/new.png"
        const groups = [group(ROOT, null), group("A", ROOT, { image: "/files/new.png" }), group("B", ROOT, { image: "/files/new.png" })]
        const r = planCategoryTree({
            groups,
            categories: [
                mirrored("a", "A", { metadata: { [IMAGE_KEY]: "https://cdn/own.png" } }),
                mirrored("b", "B", { metadata: { [IMAGE_KEY]: "https://erp.example.com/files/old.png", [GROUP_IMAGE_KEY]: "https://erp.example.com/files/old.png" } }),
            ],
            visible: new Set(["A", "B"]),
            baseUrl: "https://erp.example.com",
        })
        expect(planOf(r, "A").patch).toBeUndefined()
        expect(planOf(r, "B").patch!.metadata).toMatchObject({ [IMAGE_KEY]: url, [GROUP_IMAGE_KEY]: url })
    })
})

describe("storefront visibility", () => {
    it("counts what is filed below a group", () => {
        const groups = [group(ROOT, null), group("A"), group("B", "A"), group("C")]
        expect(groupsWithStock(groups, new Map([["B", 3], ["C", 0]]))).toEqual(new Set(["B", "A", ROOT]))
    })

    it("keeps an empty group off the storefront, and brings it back when it has stock", () => {
        const groups = [group(ROOT, null), group("Raw Material")]
        const hidden = planCategoryTree({ groups, categories: [mirrored("rm", "Raw Material")], visible: new Set() })
        expect(planOf(hidden, "Raw Material").patch).toMatchObject({ is_internal: true, metadata: { [SYNC_INTERNAL_KEY]: true } })
        const back = planCategoryTree({
            groups,
            categories: [mirrored("rm", "Raw Material", { is_internal: true, metadata: { [SYNC_INTERNAL_KEY]: true } })],
            visible: new Set(["Raw Material"]),
        })
        expect(planOf(back, "Raw Material").patch!.is_internal).toBe(false)
    })

    it("never shows a category somebody hid by hand", () => {
        const groups = [group(ROOT, null), group("A")]
        const r = planCategoryTree({ groups, categories: [mirrored("a", "A", { is_internal: true })], visible: new Set(["A"]) })
        expect(planOf(r, "A").patch?.is_internal).toBeUndefined()
    })

    it("keeps a category the store still sells from", () => {
        const groups = [group(ROOT, null), group("A")]
        const r = planCategoryTree({ groups, categories: [mirrored("a", "A")], visible: new Set(), keepVisible: new Set(["a"]) })
        expect(planOf(r, "A").patch?.is_internal).toBeUndefined()
    })

    it("on a quick pass leaves visibility alone, and starts a new category hidden", () => {
        const groups = [group(ROOT, null), group("A"), group("New")]
        const r = planCategoryTree({ groups, categories: [mirrored("a", "A")], visible: null })
        expect(planOf(r, "A").patch).toBeUndefined()
        expect(planOf(r, "New").create).toMatchObject({ is_internal: true, metadata: { [SYNC_INTERNAL_KEY]: true } })
    })
})

describe("small rules", () => {
    it("treats plurals and ampersands as the same name", () => {
        expect(sameGroupName("Generators", "Generator")).toBe(true)
        expect(sameGroupName("Oil and Lubricants", "Oil & Lubricants")).toBe(true)
        expect(sameGroupName("Bearings & Transmission", "Bearings")).toBe(false)
    })

    it("makes a handle unique, scoped to the parent first", () => {
        expect(uniqueHandle("Oil & Lubricants", new Set())).toBe("oil-and-lubricants")
        expect(uniqueHandle("Oil & Lubricants", new Set(["oil-and-lubricants"]), "generators")).toBe("generators-oil-and-lubricants")
        expect(uniqueHandle("Oil", new Set(["oil", "oil-2"]))).toBe("oil-3")
    })

    it("only offers an image a browser can load", () => {
        expect(publicImageUrl("/files/a.png", "https://erp.example.com/")).toBe("https://erp.example.com/files/a.png")
        expect(publicImageUrl("https://cdn/a.png", "https://erp.example.com")).toBe("https://cdn/a.png")
        expect(publicImageUrl("/private/files/a.png", "https://erp.example.com")).toBeNull()
        expect(publicImageUrl("", "https://erp.example.com")).toBeNull()
    })
})

describe("filing products", () => {
    const base = { categoryOfGroup: new Map([["Spare Parts", "spares"], ["Engine", "engine"]]), mirroredIds: new Set(["spares", "engine"]), groupKey: "category" }

    it("swaps the old group's category and keeps ones assigned by hand", () => {
        expect(nextCategoryIds(["engine", "keyword"], "spares", new Set(["spares", "engine"]))).toEqual(["keyword", "spares"])
        expect(nextCategoryIds(["spares", "keyword"], "spares", new Set(["spares"]))).toBeNull()
    })

    it("takes ERPNext's live group over the one stored at the last pull, and reports the stale name", () => {
        const plan = planProductFiling({
            ...base,
            products: [{ id: "p1", item_code: "X", metadata: { category: "Old name" }, categories: [] }],
            itemGroups: new Map([["X", "Spare Parts"]]),
        })
        expect(plan.batches).toEqual([{ categoryIds: ["spares"], productIds: ["p1"] }])
        expect(plan.staleGroups).toEqual([{ id: "p1", group: "Spare Parts" }])
    })

    it("falls back to the stored group for an Item gone from ERPNext, and skips the store's own products", () => {
        const plan = planProductFiling({
            ...base,
            products: [
                { id: "gone", item_code: "G", metadata: { category: "Engine" }, categories: [] },
                { id: "own", item_code: null, metadata: { category: "Engine" }, categories: [] },
            ],
            itemGroups: new Map(),
        })
        expect(plan.batches).toEqual([{ categoryIds: ["engine"], productIds: ["gone"] }])
    })

    it("reports a group the tree does not have", () => {
        const plan = planProductFiling({ ...base, products: [{ id: "p", item_code: "X", metadata: {} }], itemGroups: new Map([["X", "Nope"]]) })
        expect(plan.batches).toEqual([])
        expect(plan.unmapped.get("Nope")).toBe(1)
    })
})

describe("a category changed in Medusa", () => {
    const created = "product-category.created"
    const updated = "product-category.updated"

    it("a new top-level category becomes a group under ERPNext's root", () => {
        const plan = planCategoryPush({ event: created, category: cat("c", " Pumps "), rootGroup: ROOT })
        expect(plan).toEqual({
            action: "create",
            parentGroup: ROOT,
            doc: { doctype: "Item Group", item_group_name: "Pumps", parent_item_group: ROOT, is_group: 0 },
        })
    })

    it("a new child nests under its parent's group, and only if the parent is one", () => {
        const child = cat("c", "Pumps", { parent_category_id: "p" })
        expect(planCategoryPush({ event: created, category: child, parentCategory: mirrored("p", "Spare Parts"), rootGroup: ROOT })).toMatchObject({ action: "create", parentGroup: "Spare Parts" })
        expect(planCategoryPush({ event: created, category: child, parentCategory: cat("p", "Seed"), rootGroup: ROOT }).action).toBe("skip")
    })

    it("a category that already exists stays the store's own", () => {
        expect(planCategoryPush({ event: updated, category: cat("c", "Seed"), rootGroup: ROOT }).action).toBe("skip")
    })

    it("a category filled by rule never becomes a group", () => {
        const kw = cat("c", "Air filters", { metadata: { match_keywords: ["air filter"] } })
        expect(planCategoryPush({ event: created, category: kw, rootGroup: ROOT }).action).toBe("skip")
    })

    it("moving a mirrored category moves its group, and only when it really moved", () => {
        const c = mirrored("c", "Filter", { parent_category_id: "p" })
        const parent = mirrored("p", "Generator")
        expect(planCategoryPush({ event: updated, category: c, parentCategory: parent, rootGroup: ROOT, remoteParent: ROOT })).toEqual({ action: "reparent", group: "Filter", parentGroup: "Generator" })
        expect(planCategoryPush({ event: updated, category: c, parentCategory: parent, rootGroup: ROOT, remoteParent: "Generator" }).action).toBe("skip")
    })
})

describe("two categories for one group", () => {
    const groups = [group(ROOT, null), group("Batteries")]
    const a = mirrored("pcat_a", "Batteries", { handle: "batteries" })
    const b = mirrored("pcat_b", "Batteries", { handle: "batteries-2" })

    it("keeps one and hides the other, whatever order the database lists them in", () => {
        for (const categories of [[a, b], [b, a]]) {
            const r = planCategoryTree({ groups, categories, visible: new Set(["Batteries"]) })
            expect(planOf(r, "Batteries")).toMatchObject({ id: "pcat_a", action: "keep" })
            expect(r.hide).toEqual([
                expect.objectContaining({ id: "pcat_b", metadata: expect.objectContaining({ [SYNC_HIDDEN_KEY]: true, [DUPLICATE_OF_KEY]: "pcat_a" }) }),
            ])
            expect(r.notes.join(" ")).toContain("duplicates")
        }
    })

    it("prefers the shown category over a hidden one, even with the later id", () => {
        const r = planCategoryTree({
            groups,
            categories: [{ ...a, is_active: false }, b],
            visible: new Set(["Batteries"]),
        })
        expect(planOf(r, "Batteries").id).toBe("pcat_b")
        expect(r.hide).toEqual([])
    })

    it("does not hide the duplicate again once it is hidden", () => {
        const r = planCategoryTree({ groups, categories: [a, { ...b, is_active: false }], visible: new Set(["Batteries"]) })
        expect(r.hide).toEqual([])
    })

    it("never revives the duplicate it hid", () => {
        const hidden = { ...b, is_active: false, metadata: { ...b.metadata, [SYNC_HIDDEN_KEY]: true, [DUPLICATE_OF_KEY]: "pcat_a" } }
        const r = planCategoryTree({ groups, categories: [a, hidden], visible: new Set(["Batteries"]) })
        expect(r.planned.filter((p) => p.id === "pcat_b")).toEqual([])
    })
})

describe("a handle for a category whose parent is made in the same pass", () => {
    it("is scoped by the parent's slug, never its raw group name", () => {
        expect(uniqueHandle("Batteries", new Set(["batteries"]), "Generator Spares")).toBe("generator-spares-batteries")
        const groups = [group(ROOT, null), group("Generator Spares", ROOT, { is_group: 1 }), group("Batteries", "Generator Spares")]
        const r = planCategoryTree({ groups, categories: [cat("old", "Other", { handle: "batteries" })], visible: new Set(["Generator Spares", "Batteries"]) })
        expect(planOf(r, "Batteries").create!.handle).toBe("generator-spares-batteries")
    })
})

describe("drift the report tells about", () => {
    it("names a shown category that is no Item Group, and ignores the store's own rule-filled ones", () => {
        const r = planCategoryTree({
            groups: [group(ROOT, null), group("Engine")],
            categories: [mirrored("e", "Engine"), cat("legacy", "Engines", { handle: "gen-engine" }), cat("kw", "Cables", { metadata: { match_keywords: ["cable"] } })],
            visible: new Set(["Engine"]),
        })
        expect(r.notes).toEqual(["1 shown category is not an Item Group: gen-engine"])
    })

    it("says so when a group with products has a category hidden by hand, and leaves it hidden", () => {
        const r = planCategoryTree({
            groups: [group(ROOT, null), group("Generator")],
            categories: [mirrored("g", "Generators", { is_internal: true, metadata: { [GROUP_KEY]: "Generator", [GROUP_CREATED_KEY]: "created-Generator" } })],
            visible: new Set(["Generator"]),
        })
        expect(r.notes.join(" ")).toContain("Generator: has products to sell but its category")
        expect(planOf(r, "Generator").patch?.is_internal).toBeUndefined()
    })

    it("stays quiet about a category the sync hid itself", () => {
        const r = planCategoryTree({
            groups: [group(ROOT, null), group("Generator")],
            categories: [mirrored("g", "Generator", { is_internal: true, metadata: { [GROUP_KEY]: "Generator", [GROUP_CREATED_KEY]: "created-Generator", [SYNC_INTERNAL_KEY]: true } })],
            visible: new Set(["Generator"]),
        })
        expect(r.notes).toEqual([])
        expect(planOf(r, "Generator").patch?.is_internal).toBe(false)
    })

    it("counts products whose Item is gone apart from a group missing from the tree", () => {
        const plan = planProductFiling({
            categoryOfGroup: new Map([["Engine", "engine"]]),
            mirroredIds: new Set(["engine"]),
            groupKey: "category",
            products: [
                { id: "a", item_code: "A", metadata: { category: "Oil & Lubricants" }, categories: [] },
                { id: "b", item_code: "B", metadata: {}, categories: [] },
            ],
            itemGroups: new Map([["B", "Nope"]]),
        })
        expect(plan.gone).toBe(1)
        expect([...plan.unmapped]).toEqual([["Nope", 1]])
    })
})
