import { describe, expect, it } from "vitest"
import { CategorySyncBusy, runCategorySync, withCategoryLock, type CategorySyncDeps } from "../item-group-sync"

/** A category store that yields between reading and writing, as a database does. */
function fakeProductModule() {
    const rows: any[] = []
    let seq = 0
    return {
        rows,
        listProductCategories: async () => {
            const snapshot = rows.map((r) => ({ ...r }))
            await new Promise((r) => setTimeout(r, 5))
            return snapshot
        },
        createProductCategories: async (input: any) => {
            await new Promise((r) => setTimeout(r, 5))
            const row = { id: `pcat_${++seq}`, is_active: true, ...input }
            rows.push(row)
            return row
        },
        updateProductCategories: async (id: string, patch: any) => Object.assign(rows.find((r) => r.id === id), patch),
    }
}

/** Postgres' transaction-scoped advisory lock, shared by every "process" that holds this object. */
function fakePg() {
    let held = false
    return {
        transaction: async (fn: (trx: any) => Promise<any>) => {
            let mine = false
            const trx = {
                raw: async () => {
                    mine = !held
                    held = true
                    return { rows: [{ ok: mine }] }
                },
            }
            try {
                return await fn(trx)
            } finally {
                if (mine) held = false
            }
        },
    }
}

const groups = [
    { name: "All Item Groups", parent_item_group: null },
    { name: "Generator", parent_item_group: "All Item Groups", is_group: 1, creation: "c1" },
    { name: "Engine", parent_item_group: "Generator", creation: "c2" },
]

function deps(productModule: any, pg?: any): CategorySyncDeps {
    return { client: {} as any, productModule, query: {}, baseUrl: null, groupKey: "category", itemCodeKey: "erpnext_item_code", pg }
}

describe("only one pass writes the category tree", () => {
    it("lets a second pass in the same process wait its turn instead of creating the tree twice", async () => {
        const pm = fakeProductModule()
        const results = await Promise.allSettled([
            runCategorySync(deps(pm), { mode: "quick", groups }),
            runCategorySync(deps(pm), { mode: "quick", groups }),
        ])
        expect(results.filter((r) => r.status === "rejected").map((r: any) => r.reason)).toEqual([expect.any(CategorySyncBusy)])
        expect(pm.rows.map((r) => r.name).sort()).toEqual(["Engine", "Generator"])
    })

    it("keeps a pass out while a pass in another process holds Postgres' advisory lock", async () => {
        const pm = fakeProductModule()
        const pg = fakePg()
        // Another process: it has its own in-process flag, so only the database lock can stop this one.
        let release!: () => void
        const otherHolds = new Promise<void>((r) => (release = r))
        const other = pg.transaction(async (trx: any) => {
            await trx.raw()
            await otherHolds
        })
        await new Promise((r) => setTimeout(r, 1))
        await expect(runCategorySync(deps(pm, pg), { mode: "quick", groups })).rejects.toBeInstanceOf(CategorySyncBusy)
        expect(pm.rows).toHaveLength(0)
        release()
        await other
        await expect(runCategorySync(deps(pm, pg), { mode: "quick", groups })).resolves.toMatchObject({ created: 2 })
    })

    it("a dry run neither needs nor takes the lock", async () => {
        const pm = fakeProductModule()
        const pg = fakePg()
        const [live, dry] = await Promise.all([
            runCategorySync(deps(pm, pg), { mode: "quick", groups }),
            runCategorySync(deps(pm, pg), { mode: "quick", groups, dryRun: true }),
        ])
        expect(live.created).toBe(2)
        expect(dry.dry_run).toBe(true)
        expect(pm.rows).toHaveLength(2)
    })

    it("frees the lock when a pass fails", async () => {
        await expect(withCategoryLock({}, async () => { throw new Error("boom") })).rejects.toThrow("boom")
        await expect(withCategoryLock({}, async () => "ok")).resolves.toBe("ok")
    })
})

describe("a pass over a tree that already has a duplicate", () => {
    it("hides the second category for a group, and a rerun changes nothing", async () => {
        const pm = fakeProductModule()
        const meta = (g: string, c: string) => ({ erpnext_item_group: g, erpnext_item_group_created: c, erpnext_is_group: g === "Generator" })
        pm.rows.push(
            { id: "pcat_1", name: "Generators", handle: "generators", parent_category_id: null, is_active: true, is_internal: false, metadata: meta("Generator", "c1") },
            { id: "pcat_2", name: "Engine", handle: "engine", parent_category_id: "pcat_1", is_active: true, is_internal: false, metadata: meta("Engine", "c2") },
            { id: "pcat_3", name: "Engine", handle: "gen-engine", parent_category_id: "pcat_1", is_active: true, is_internal: false, metadata: meta("Engine", "c2") },
        )
        const first = await runCategorySync(deps(pm), { mode: "quick", groups })
        expect(first.hidden).toBe(1)
        expect(pm.rows.find((r) => r.id === "pcat_3")).toMatchObject({ is_active: false, metadata: { erpnext_duplicate_of: "pcat_2" } })
        const second = await runCategorySync(deps(pm), { mode: "quick", groups })
        expect(second.hidden).toBe(0)
    })
})
