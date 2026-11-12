import { moduleIntegrationTestRunner } from "@medusajs/test-utils"
import { Modules } from "@medusajs/framework/utils"
import { dirname } from "node:path"
import { CategorySyncBusy, runCategorySync, type CategorySyncDeps } from "../src/modules/erpnext/item-group-sync"

const ROOT = "All Item Groups"
const g = (name: string, parent: string | null, creation: string, is_group = 0) => ({ name, item_group_name: name, parent_item_group: parent, is_group, creation })

moduleIntegrationTestRunner<any>({
    moduleName: Modules.PRODUCT,
    resolve: dirname(require.resolve("@medusajs/product/package.json")),
    testSuite: ({ service }) => {
        const deps = (): CategorySyncDeps => ({ client: {} as any, productModule: service, query: {}, baseUrl: null, groupKey: "category", itemCodeKey: "erpnext_item_code" })
        const tree = async () => {
            const rows: any[] = await service.listProductCategories({}, { select: ["id", "name", "handle", "parent_category_id", "is_active", "is_internal", "metadata"], take: 1000 })
            const byId = new Map(rows.map((r) => [r.id, r]))
            return rows
                .map((r) => ({ name: r.name, handle: r.handle, parent: byId.get(r.parent_category_id)?.name ?? null, active: r.is_active, group: r.metadata?.erpnext_item_group }))
                .sort((a, b) => a.handle.localeCompare(b.handle))
        }

        const original = () => [g(ROOT, null, "c0", 1), g("Generator", ROOT, "c1", 1), g("Spares", "Generator", "c2", 1), g("Batteries", "Spares", "c3"), g("Engine", "Generator", "c4")]
        // The runner empties the database between tests, so each one grows its own tree.
        const seed = () => runCategorySync(deps(), { mode: "quick", groups: original() })

        describe("the Item Group lifecycle against a real database", () => {
            it("creates the tree, then changes nothing on a second pass", async () => {
                const groups = original()
                const first = await runCategorySync(deps(), { mode: "quick", groups })
                expect(first.created).toBe(4)
                expect(await tree()).toEqual([
                    { name: "Batteries", handle: "batteries", parent: "Spares", active: true, group: "Batteries" },
                    { name: "Engine", handle: "engine", parent: "Generator", active: true, group: "Engine" },
                    { name: "Generator", handle: "generator", parent: null, active: true, group: "Generator" },
                    { name: "Spares", handle: "spares", parent: "Generator", active: true, group: "Spares" },
                ])
                const second = await runCategorySync(deps(), { mode: "quick", groups })
                expect(second).toMatchObject({ created: 0, adopted: 0, renamed: 0, reparented: 0, updated: 0, hidden: 0 })
            })

            it("follows a rename by creation stamp, a move, and hides what is deleted", async () => {
                await seed()
                const renamed = [
                    g(ROOT, null, "c0", 1),
                    g("Generator", ROOT, "c1", 1),
                    g("Generator Spares", "Generator", "c2", 1), // was Spares
                    g("Batteries", "Generator Spares", "c3"),
                    // Engine deleted
                ]
                const r1 = await runCategorySync(deps(), { mode: "quick", groups: renamed })
                expect(r1).toMatchObject({ renamed: 1, hidden: 1, created: 0 })
                const moved = renamed.map((x) => (x.name === "Batteries" ? { ...x, parent_item_group: "Generator" } : x))
                const r2 = await runCategorySync(deps(), { mode: "quick", groups: moved })
                expect(r2.reparented).toBe(1)
                const t = await tree()
                expect(t.find((x) => x.group === "Generator Spares")).toMatchObject({ name: "Generator Spares", handle: "spares" })
                expect(t.find((x) => x.group === "Batteries")!.parent).toBe("Generator")
                expect(t.find((x) => x.group === "Engine")!.active).toBe(false)
                expect((await runCategorySync(deps(), { mode: "quick", groups: moved })).hidden).toBe(0)
            })

            it("hides a second category made for a group, and keeps the same one on every run", async () => {
                await seed()
                const groups = original()
                const [dup] = await service.createProductCategories([
                    { name: "Batteries", handle: "batteries-dup", is_active: true, metadata: { erpnext_item_group: "Batteries", erpnext_item_group_created: "c3" } },
                ])
                const r = await runCategorySync(deps(), { mode: "quick", groups })
                expect(r.hidden).toBe(1)
                const rows: any[] = await service.listProductCategories({ metadata: { erpnext_item_group: "Batteries" } }, { select: ["id", "is_active", "metadata"] })
                const hidden = rows.filter((x) => !x.is_active)
                const kept = rows.filter((x) => x.is_active)
                expect(kept).toHaveLength(1)
                expect(hidden).toHaveLength(1)
                expect(hidden[0].metadata.erpnext_duplicate_of).toBe(kept[0].id)
                void dup
                const live = (await tree()).filter((x) => x.group === "Batteries" && x.active)
                expect(live).toHaveLength(1)
                expect((await runCategorySync(deps(), { mode: "quick", groups })).hidden).toBe(0)
            })

            it("makes one category when two passes start together", async () => {
                const groups = [g(ROOT, null, "d0", 1), g("Racing", ROOT, "d1", 1)]
                const results = await Promise.allSettled([
                    runCategorySync(deps(), { mode: "quick", groups }),
                    runCategorySync(deps(), { mode: "quick", groups }),
                ])
                expect(results.filter((x) => x.status === "rejected").map((x: any) => x.reason)).toEqual([expect.any(CategorySyncBusy)])
                expect((await tree()).filter((x) => x.group === "Racing")).toHaveLength(1)
            })
        })
    },
})
