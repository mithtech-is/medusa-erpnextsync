import { readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * Folder names Medusa's plugin build refuses to compile. Copied from
 * `backendIgnoreFiles` in @medusajs/framework/dist/build-tools/compiler.js;
 * matched against whole path segments (compiler-utils.js, isFileIgnored).
 *
 * A route under one of these compiles fine in development, type-checks, and
 * is simply absent from `.medusa/server` — so the endpoint answers 404 in
 * every deployed store and nothing reports it. All four channel test
 * endpoints shipped that way, in folders named `test`.
 */
const DROPPED_BY_BUILD = ["test", "integration-tests", "unit-tests"]

const API_ROOT = join(__dirname, "..", "..", "..", "api")

function routeFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) return routeFiles(full)
        return name === "route.ts" ? [full] : []
    })
}

describe("API routes survive the plugin build", () => {
    const routes = routeFiles(API_ROOT)

    it("finds the routes it is meant to check", () => {
        expect(routes.length).toBeGreaterThan(0)
    })

    it.each(routes.map((r) => [relative(API_ROOT, r)]))(
        "%s is not in a folder the build drops",
        (rel) => {
            const segments = rel.split(sep)
            const hit = segments.find((s) => DROPPED_BY_BUILD.includes(s))
            expect(hit, `rename the "${hit}" folder in src/api/${rel}`).toBeUndefined()
        },
    )
})
