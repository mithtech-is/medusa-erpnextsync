import { defineConfig } from "vitest/config"

/**
 * Item Group sync against the real Product module and a real Postgres, with a
 * stand-in for ERPNext. Opt-in: `npm run test:integration` with a local
 * Postgres (DB_USERNAME, and DB_PASSWORD if it needs one).
 */
export default defineConfig({
    test: {
        include: ["integration/**/*.int.spec.ts"],
        environment: "node",
        globals: true,
        pool: "threads",
        globalSetup: ["./integration/global-setup.ts"],
        testTimeout: 60_000,
        hookTimeout: 60_000,
        fileParallelism: false,
    },
})
