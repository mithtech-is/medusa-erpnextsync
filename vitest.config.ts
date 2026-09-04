import { defineConfig } from "vitest/config"

/**
 * Unit tests only. Everything under `src/modules/erpnext/__tests__` is a
 * pure function — the envelope, the mapping engine, the trigger grammar,
 * the push guard, the mapping conflict rule — so the suite runs in
 * milliseconds with no database, no Medusa container and no ERPNext.
 *
 * The Medusa plugin compiler drops any folder literally named `test` from
 * the built output; `__tests__` is kept out of `files` in package.json
 * instead, so the published package carries none of this.
 */
export default defineConfig({
    test: {
        include: ["src/**/__tests__/**/*.spec.ts"],
        environment: "node",
    },
})
