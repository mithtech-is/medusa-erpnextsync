import { defineConfig } from "vitest/config"

/**
 * Rehearsals against a live ERPNext. Opt-in: `npm run rehearsal` with
 * ERPNEXT_URL, ERPNEXT_API_KEY, ERPNEXT_API_SECRET and, per rehearsal,
 * the fixtures it names (ERPNEXT_TEST_CUSTOMER). Without them every
 * rehearsal is skipped, so the folder is harmless in CI.
 */
export default defineConfig({
    test: {
        include: ["rehearsal/**/*.spec.ts"],
        environment: "node",
        testTimeout: 120_000,
        hookTimeout: 120_000,
        fileParallelism: false,
    },
})
